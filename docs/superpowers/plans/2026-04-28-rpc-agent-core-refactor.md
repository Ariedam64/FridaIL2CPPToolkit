# RPC Agent — Core Extraction & sender.ts Decomposition Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/rpc-agent/sender.ts` (4827 lines, ~95 RPCs) into `core/` + `features/` to eliminate the constant ~500ms freeze on every RPC call to Dofus.

**Architecture:** Two-layer split. `core/` holds Frida/IL2CPP infrastructure (sticky singleton cache, batched main-thread dispatcher, IL2CPP utils, generic field ops) and is the only place `Il2Cpp.gc.choose` and `pendingMainWork` live. `features/` modules hold Dofus business logic, must import from `core/` only. Migration is staged across 4 ship-able phases : create core, migrate sender.ts to use it (the perf win lands here), decompose into features, drop sender.ts.

**Tech Stack:** TypeScript, frida-il2cpp-bridge, esbuild (existing build chain), Node.js, no test framework (verification is empirical via attached Dofus + smoke scripts).

**Spec reference:** [docs/superpowers/specs/2026-04-28-rpc-agent-core-refactor-design.md](../specs/2026-04-28-rpc-agent-core-refactor-design.md)

---

## Verification Model

This codebase has no unit-test infrastructure (IL2CPP runtime can't be mocked). Every code-changing task ends with one or more of these gates :

- **Compile gate** — run `npx tsc --noEmit -p src/rpc-agent/tsconfig.json` (or equivalent project config). Must report 0 errors.
- **Build gate** — run `npm run build:rpc` (or whichever script produces `build/rpc-agent.js`). Must complete without errors.
- **Smoke gate** — with Dofus attached at `http://localhost:3001`, call 3-5 representative RPCs via `curl -X POST localhost:3001/api/call -d '{"method":"X","args":[]}'`. Outputs must match the baseline saved in Phase 0.

Tasks that don't change runtime code (e.g. creating a baseline file) skip the gates.

---

## Phase 0 — Preflight & Baselines

### Task 0.1: Verify build pipeline works

**Files:** none (read-only check).

- [ ] **Step 1: Identify the build command**

Run: `cat f:/FridaIL2CPPToolkit/package.json | grep -A 1 '"scripts"'`
Expected: see scripts including `build` or `build:rpc` that compiles `src/rpc-agent/index.ts` → `build/rpc-agent.js`.

- [ ] **Step 2: Run the build to confirm clean baseline**

Run: `npm run build` (or the rpc-agent-specific script if separate)
Expected: PASS, `build/rpc-agent.js` regenerated, 0 errors.

- [ ] **Step 3: Confirm typecheck passes**

Run: `npx tsc --noEmit -p src/rpc-agent` (or root tsconfig if no project config)
Expected: 0 errors.

### Task 0.2: Capture pre-refactor RPC output baselines

**Files:**
- Create: `tmp/baseline/snapshotDttState.json`
- Create: `tmp/baseline/dumpOutgoingEdges.json`
- Create: `tmp/baseline/getDispatcherStats.json`

This captures the "before" state so each phase can diff against it. Requires Dofus attached.

- [ ] **Step 1: Create baseline directory**

Run: `mkdir -p f:/FridaIL2CPPToolkit/tmp/baseline`

- [ ] **Step 2: Capture snapshotDttState**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -H "Content-Type: application/json" \
    -d '{"method":"snapshotDttState","args":[]}' \
    > f:/FridaIL2CPPToolkit/tmp/baseline/snapshotDttState.json
```
Expected: file contains `{"result":{"ok":true,"fields":{...}}}`.

- [ ] **Step 3: Capture dumpOutgoingEdges**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -H "Content-Type: application/json" \
    -d '{"method":"dumpOutgoingEdges","args":[]}' \
    > f:/FridaIL2CPPToolkit/tmp/baseline/dumpOutgoingEdges.json
```
Expected: file ~400KB+, contains adjacency map.

- [ ] **Step 4: Capture getMainThreadDispatcherStats**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -H "Content-Type: application/json" \
    -d '{"method":"getMainThreadDispatcherStats","args":[]}' \
    > f:/FridaIL2CPPToolkit/tmp/baseline/getDispatcherStats.json
```
Expected: `{"result":{"attached":true,"fireCount":N,"workCount":M,"pending":false}}`.

- [ ] **Step 5: Add tmp/ to .gitignore (if not already)**

Run: `grep -q '^tmp/' f:/FridaIL2CPPToolkit/.gitignore || echo 'tmp/' >> f:/FridaIL2CPPToolkit/.gitignore`

### Task 0.3: Write a perf measurement helper script

**Files:**
- Create: `dofus-app/scripts/measure-rpc-perf.js`

- [ ] **Step 1: Write the script**

```javascript
// Measure wall time of representative RPCs. Used as before/after gauge.
// Usage: node dofus-app/scripts/measure-rpc-perf.js
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const RPCS = [
    { method: "getMainThreadDispatcherStats", args: [] },
    { method: "snapshotDttState", args: [] },
    { method: "isAutopilotActive", args: [] },
    { method: "getDispatcherStats", args: [] }, // post-refactor only — will 404 pre-refactor
];

(async () => {
    for (const r of RPCS) {
        const samples = [];
        for (let i = 0; i < 5; i++) {
            const t0 = Date.now();
            try {
                const res = await (await fetch("http://localhost:3001/api/call", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(r),
                })).json();
                samples.push(Date.now() - t0);
            } catch (e) {
                samples.push(-1);
            }
        }
        console.log(`${r.method.padEnd(36)} samples=${samples.join("ms,")}ms`);
    }
})();
```

- [ ] **Step 2: Run pre-refactor baseline**

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js > f:/FridaIL2CPPToolkit/tmp/baseline/perf-before.txt`
Expected: each sample ~500ms (this is what we're fixing). Save the output for reference.

- [ ] **Step 3: Commit Phase 0 setup**

```bash
git add dofus-app/scripts/measure-rpc-perf.js .gitignore
git commit -m "chore(refactor): add perf measurement helper + capture baselines"
```

---

## Phase 1 — Land `core/` (no behavior change)

This phase creates 4 new files in `src/rpc-agent/core/` that **mirror or extract existing helpers** from `sender.ts`. After Phase 1, `sender.ts` re-imports from `core/` ; behavior is identical, perf is identical. Phase 2 is where the perf win lands.

### Task 1.1: Create `core/il2cpp-utils.ts`

**Files:**
- Create: `src/rpc-agent/core/il2cpp-utils.ts`

This file extracts the helpers currently inlined at the top of `sender.ts` (lines 26-118 in current state) : `inVm`, `getClass` + `classIndex`, `getEnumValues` + `enumValueCache`, `buildIl2cppMethodTable` + `methodTable`, `resolveFrame`, `hexPad`.

- [ ] **Step 1: Create the file with extracted helpers**

```typescript
// src/rpc-agent/core/il2cpp-utils.ts
// IL2CPP runtime helpers — class/method indexes, frame resolution, perform wrapper.
// Extracted from sender.ts (top 120 lines). Pure infrastructure, no Dofus logic.
import "frida-il2cpp-bridge";

export function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// -----------------------------------------------------------------------------
// Class index — single pass over all assemblies, ~13k classes. Lazy build,
// O(1) lookup. Without this each fresh getClass scans all assemblies again.
// -----------------------------------------------------------------------------

let classIndex: Map<string, Il2Cpp.Class> | null = null;

export function buildClassIndex(): void {
    if (classIndex) return;
    const m = new Map<string, Il2Cpp.Class>();
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) if (!m.has(k.name)) m.set(k.name, k);
        } catch {}
    }
    classIndex = m;
    console.log(`[il2cpp-utils] class index built: ${m.size} classes`);
}

export function getClass(name: string): Il2Cpp.Class | null {
    if (!classIndex) buildClassIndex();
    return classIndex!.get(name) ?? null;
}

export function getClassIndexSize(): number {
    return classIndex ? classIndex.size : 0;
}

// -----------------------------------------------------------------------------
// Enum value cache — getEnumValues("dod", ["ddas","ddat"]) returns the static
// enum-typed Il2Cpp.Object refs. Cached by class+names key.
// -----------------------------------------------------------------------------

const enumValueCache = new Map<string, Il2Cpp.Object[]>();

export function getEnumValues(className: string, valueNames: string[]): Il2Cpp.Object[] | null {
    const key = className + ":" + valueNames.join(",");
    const cached = enumValueCache.get(key);
    if (cached) return cached;
    const k = getClass(className);
    if (!k) return null;
    const out: Il2Cpp.Object[] = [];
    for (const n of valueNames) {
        try { out.push((k.field(n) as any).value); } catch {}
    }
    if (!out.length) return null;
    enumValueCache.set(key, out);
    return out;
}

// -----------------------------------------------------------------------------
// IL2CPP method address table — resolves raw stack frames to "Cls.method+0xoff".
// Built lazily once per session (~349k entries). Used by stack-frame resolution
// in autopilot trace, hook backtrace, etc.
// -----------------------------------------------------------------------------

interface MethodRef { addrHex: string; cls: string; name: string; }
let methodTable: MethodRef[] = [];

function hexPad(p: NativePointer): string {
    const s = p.toString();
    return (s.startsWith("0x") ? s.slice(2) : s).padStart(16, "0");
}

export function buildMethodTable(): number {
    if (methodTable.length) return methodTable.length;
    const list: MethodRef[] = [];
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                try {
                    for (const m of k.methods) {
                        try {
                            const va = m.virtualAddress;
                            if (!va || va.isNull()) continue;
                            list.push({ addrHex: hexPad(va), cls: k.name, name: m.name });
                        } catch {}
                    }
                } catch {}
            }
        } catch {}
    }
    list.sort((a, b) => a.addrHex < b.addrHex ? -1 : a.addrHex > b.addrHex ? 1 : 0);
    methodTable = list;
    console.log(`[il2cpp-utils] method table built: ${list.length} entries`);
    return list.length;
}

export function getMethodTableSize(): number {
    return methodTable.length;
}

export function resolveFrame(frame: NativePointer): string {
    if (!methodTable.length) return frame.toString();
    const target = hexPad(frame);
    let lo = 0, hi = methodTable.length - 1, best = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (methodTable[mid]!.addrHex <= target) { best = mid; lo = mid + 1; }
        else { hi = mid - 1; }
    }
    if (best < 0) return frame.toString();
    const m = methodTable[best]!;
    const offset = BigInt("0x" + target) - BigInt("0x" + m.addrHex);
    if (offset < 0n || offset > 0x20000n) return frame.toString() + " (unresolved)";
    return `${m.cls}.${m.name}+0x${offset.toString(16)}`;
}
```

- [ ] **Step 2: Compile gate**

Run: `npx tsc --noEmit src/rpc-agent/core/il2cpp-utils.ts` (or full project)
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/core/il2cpp-utils.ts
git commit -m "refactor(rpc-agent): extract il2cpp-utils to core/"
```

### Task 1.2: Wire `sender.ts` to use `core/il2cpp-utils.ts`

**Files:**
- Modify: `src/rpc-agent/sender.ts:20-118` (delete extracted helpers, add import)

- [ ] **Step 1: Replace the helper definitions with an import**

Replace `sender.ts` lines 20-118 (from `import "frida-il2cpp-bridge"` through end of `resolveFrame`) with :

```typescript
import "frida-il2cpp-bridge";
import {
    inVm,
    getClass,
    buildClassIndex,
    getEnumValues,
    buildMethodTable,
    resolveFrame,
} from "./core/il2cpp-utils";
```

- [ ] **Step 2: Compile gate**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors. The build should resolve all references.

- [ ] **Step 3: Build gate**

Run: `npm run build` (or `npm run build:rpc`)
Expected: PASS, `build/rpc-agent.js` regenerated.

- [ ] **Step 4: Smoke gate (with Dofus attached)**

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js`
Expected: similar timings to baseline (no perf change yet, no regression).

- [ ] **Step 5: Diff against baseline**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -H "Content-Type: application/json" \
    -d '{"method":"snapshotDttState","args":[]}' \
    | diff - f:/FridaIL2CPPToolkit/tmp/baseline/snapshotDttState.json
```
Expected: identical output (modulo dynamic field values like timestamps if present).

- [ ] **Step 6: Commit**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): use core/il2cpp-utils from sender.ts"
```

### Task 1.3: Create `core/dispatch.ts`

**Files:**
- Create: `src/rpc-agent/core/dispatch.ts`

This is the **new** API. The existing `pendingMainWork` machinery in `sender.ts` (lines ~760-1804) stays untouched for now. Phase 2 will replace it.

- [ ] **Step 1: Write the new dispatcher**

```typescript
// src/rpc-agent/core/dispatch.ts
// Single source of truth for "execute work on Unity main thread".
// Replaces the inline `pendingMainWork = () => {...}` pattern via a queue.
import "frida-il2cpp-bridge";
import { getClass } from "./il2cpp-utils";

export interface DispatchOptions {
    timeoutMs?: number;
    label?: string;
}

interface QueueItem {
    work: () => unknown;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    label: string;
    deadline: number;
}

const TICK_BUDGET_MS = 50;
const DEFAULT_TIMEOUT_MS = 3000;

const queue: QueueItem[] = [];
let dispatcher: any = null;
const stats = {
    fireCount: 0,
    workCount: 0,
    lastWorkDurationMs: 0,
    queueHighWaterMark: 0,
};

export function runOnMainThread<T>(
    work: () => T,
    opts: DispatchOptions = {},
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        if (!ensureDispatcher()) {
            reject(new Error(`dispatcher unavailable (label=${opts.label ?? "?"})`));
            return;
        }
        const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        queue.push({
            work: work as () => unknown,
            resolve: resolve as (v: unknown) => void,
            reject,
            label: opts.label ?? "anon",
            deadline: Date.now() + timeout,
        });
        if (queue.length > stats.queueHighWaterMark) stats.queueHighWaterMark = queue.length;
    });
}

export function ensureDispatcher(): boolean {
    if (dispatcher) return true;
    const dtt = getClass("dtt");
    if (!dtt) return false;
    const tjz = dtt.tryMethod("tjz");
    if (!tjz) return false;
    try {
        dispatcher = (Interceptor as any).attach(tjz.virtualAddress, {
            onLeave() {
                stats.fireCount++;
                if (queue.length === 0) return;
                const tickStart = Date.now();
                while (queue.length > 0) {
                    const item = queue[0]!;
                    if (Date.now() > item.deadline) {
                        queue.shift();
                        item.reject(new Error(`main-thread dispatch timeout (label=${item.label})`));
                        continue;
                    }
                    const t0 = Date.now();
                    try {
                        const result = item.work();
                        stats.lastWorkDurationMs = Date.now() - t0;
                        stats.workCount++;
                        queue.shift();
                        item.resolve(result);
                    } catch (e: any) {
                        queue.shift();
                        item.reject(e instanceof Error ? e : new Error(String(e)));
                    }
                    if (Date.now() - tickStart >= TICK_BUDGET_MS) break;
                }
            },
        });
        console.log(`[dispatch] attached to dtt.tjz`);
        return true;
    } catch (e) {
        console.log(`[dispatch] attach failed: ${e}`);
        return false;
    }
}

export function getDispatcherStats() {
    return {
        attached: !!dispatcher,
        fireCount: stats.fireCount,
        workCount: stats.workCount,
        pending: queue.length,
        lastWorkDurationMs: stats.lastWorkDurationMs,
        queueHighWaterMark: stats.queueHighWaterMark,
    };
}
```

- [ ] **Step 2: Compile gate**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors. (No call sites yet — purely additive.)

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/core/dispatch.ts
git commit -m "refactor(rpc-agent): add core/dispatch with queued runOnMainThread"
```

### Task 1.4: Create `core/singletons.ts`

**Files:**
- Create: `src/rpc-agent/core/singletons.ts`

- [ ] **Step 1: Write the sticky-cache module**

```typescript
// src/rpc-agent/core/singletons.ts
// Sticky cache for live IL2CPP singletons. ONE gc.choose per class, ever.
// Replaces the 68 inline `Il2Cpp.gc.choose(klass)` calls in sender.ts.
import "frida-il2cpp-bridge";
import { getClass } from "./il2cpp-utils";

const cache = new Map<string, Il2Cpp.Object>();

function buildSingleton(className: string): Il2Cpp.Object {
    const klass = getClass(className);
    if (!klass) throw new Error(`class not found: ${className}`);
    const insts = Il2Cpp.gc.choose(klass);
    if (!insts.length) throw new Error(`no live ${className}`);
    return insts[insts.length - 1]!;
}

function getOrBuild(className: string): Il2Cpp.Object {
    const cached = cache.get(className);
    if (cached) return cached;
    const fresh = buildSingleton(className);
    cache.set(className, fresh);
    return fresh;
}

// Typed accessors for the most-used Dofus singletons.
export function getDtt(): Il2Cpp.Object { return getOrBuild("dtt"); }
export function getMapRenderer(): Il2Cpp.Object { return getOrBuild("MapRenderer"); }

// Generic accessor for less-common classes (cwq, dch, dun, dvi, …).
export function getSingleton(className: string): Il2Cpp.Object {
    return getOrBuild(className);
}

// Strict variant — re-probes liveness via `cached.class.name` throw test.
// Use only after suspected GC eviction (rare).
export function getSingletonChecked(className: string): Il2Cpp.Object {
    const cached = cache.get(className);
    if (cached) {
        try {
            if (cached.class && cached.class.name) return cached;
        } catch {}
        cache.delete(className);
    }
    return getOrBuild(className);
}

// Drop the entire cache. Wired on Frida re-attach in index.ts.
export function invalidateAllSingletons(): void {
    cache.clear();
}

export function getSingletonStats() {
    return { cached: cache.size, classes: Array.from(cache.keys()) };
}
```

- [ ] **Step 2: Compile gate**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/core/singletons.ts
git commit -m "refactor(rpc-agent): add core/singletons with sticky cache"
```

### Task 1.5: Create `core/field-ops.ts`

**Files:**
- Create: `src/rpc-agent/core/field-ops.ts`

This generalizes the `nullDttField`, `setIntField`, `probeStaticField`, `writeDpglState`, `nullFozField` patterns into one module. **Look at `sender.ts` functions** of the same names for the type-dispatch logic before writing.

- [ ] **Step 1: Find the type-dispatch logic to mirror**

Run: `grep -n -A 15 "^export function nullDttField" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Read the body — note how it dispatches on `f.type.name` (`"Boolean"`, `"Int32"`, `"Int64"`, etc.) and writes either via `field.value = ptr(0)` or typed assign.

Run: `grep -n -A 25 "^export function setIntField" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Note the static-vs-instance dispatch.

- [ ] **Step 2: Write `core/field-ops.ts`**

```typescript
// src/rpc-agent/core/field-ops.ts
// Generic field accessors used by ~20 RPCs across sender.ts.
// Centralizes the type dispatch (Bool / Int32 / Int64 / Object / string / …).
import "frida-il2cpp-bridge";

export interface FieldRead {
    type: string;
    value: string;
    raw: any;
}

export function readField(obj: Il2Cpp.Object, name: string): FieldRead {
    const f = (obj as any).field(name);
    const type = f.type?.name ?? "?";
    const raw = f.value;
    return { type, value: raw === null || raw === undefined ? "<null>" : String(raw), raw };
}

export function writeField(obj: Il2Cpp.Object, name: string, value: unknown): void {
    const f = (obj as any).field(name);
    const t = f.type?.name ?? "";
    if (t === "Boolean") f.value = !!value;
    else if (t === "Int32" || t === "UInt32") f.value = Number(value);
    else if (t === "Int64" || t === "UInt64") f.value = Number(value);
    else if (t === "Single" || t === "Double") f.value = Number(value);
    else f.value = value as any;
}

export function nullField(obj: Il2Cpp.Object, name: string): void {
    const f = (obj as any).field(name);
    const t = f.type?.name ?? "";
    if (t === "Boolean") f.value = false;
    else if (t === "Int32" || t === "UInt32" || t === "Int64" || t === "UInt64") f.value = 0;
    else f.value = ptr(0);
}

export function readStaticField(klass: Il2Cpp.Class, name: string): FieldRead {
    const f = (klass as any).field(name);
    const type = f.type?.name ?? "?";
    const raw = f.value;
    return { type, value: raw === null || raw === undefined ? "<null>" : String(raw), raw };
}

export function writeStaticField(klass: Il2Cpp.Class, name: string, value: unknown): void {
    const f = (klass as any).field(name);
    const t = f.type?.name ?? "";
    if (t === "Boolean") f.value = !!value;
    else if (t === "Int32" || t === "UInt32") f.value = Number(value);
    else if (t === "Int64" || t === "UInt64") f.value = Number(value);
    else if (t === "Single" || t === "Double") f.value = Number(value);
    else f.value = value as any;
}

export function nullStaticField(klass: Il2Cpp.Class, name: string): void {
    const f = (klass as any).field(name);
    const t = f.type?.name ?? "";
    if (t === "Boolean") f.value = false;
    else if (t === "Int32" || t === "UInt32" || t === "Int64" || t === "UInt64") f.value = 0;
    else f.value = ptr(0);
}

// Walk a chain like "dpgl._state" — returns final value as string.
// Stops on null intermediate, returns "<null>".
export function readFieldPath(start: Il2Cpp.Object | Il2Cpp.Class, path: string): string {
    const parts = path.split(".");
    let cur: any = start;
    for (let i = 0; i < parts.length; i++) {
        const name = parts[i]!;
        try {
            const f = cur.field(name);
            const v = f.value;
            if (i === parts.length - 1) return v === null || v === undefined ? "<null>" : String(v);
            if (v === null || v === undefined) return "<null>";
            cur = v;
        } catch (e) {
            return `<err: ${String(e).slice(0, 40)}>`;
        }
    }
    return "<empty path>";
}
```

- [ ] **Step 3: Compile gate**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/core/field-ops.ts
git commit -m "refactor(rpc-agent): add core/field-ops generic field accessors"
```

### Task 1.6: Pre-warm indexes at agent attach + wire singleton invalidation

**Files:**
- Modify: `src/rpc-agent/index.ts`

- [ ] **Step 1: Read the current index.ts**

Run: `cat f:/FridaIL2CPPToolkit/src/rpc-agent/index.ts`
Expected: 12 lines, imports rpc-methods, sets `rpc.exports`, runs `Il2Cpp.perform` with a "ready" log.

- [ ] **Step 2: Update to pre-warm + invalidate-on-unload**

Replace the file contents with :

```typescript
// Frida agent entry point. Compiled by `npm run build:rpc` → build/rpc-agent.js.
import "frida-il2cpp-bridge";
import { getRpcMethods } from "./rpc-methods";
import { buildClassIndex, buildMethodTable } from "./core/il2cpp-utils";
import { ensureDispatcher } from "./core/dispatch";
import { invalidateAllSingletons } from "./core/singletons";

const rpcMethods = getRpcMethods();
rpc.exports = rpcMethods;

Il2Cpp.perform(() => {
    // Pre-warm indexes off the main thread. Pays the IL2CPP scan cost once at
    // attach instead of inside the first RPC's main-thread callback.
    buildClassIndex();
    buildMethodTable();
    ensureDispatcher();
    console.log("[rpc-agent] ready. Exposed methods: " + Object.keys(rpcMethods).sort().join(", "));
    send({ type: "agent-ready" });
});

// Drop singleton cache when Frida re-attaches or unloads the script.
(Script as any).bindWeak?.(globalThis, () => invalidateAllSingletons());
```

Note: `Script.bindWeak` is the documented Frida pattern for unload hooks. If your Frida version uses a different API (e.g. `Script.unload.connect`), substitute that — see `https://frida.re/docs/javascript-api/#script` for the version in use.

- [ ] **Step 3: Compile gate**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors.

- [ ] **Step 4: Build gate**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Smoke gate**

Restart the agent (re-attach Frida via `/api/reload`). Watch the console : you should see `[il2cpp-utils] class index built: ~13000 classes`, `[il2cpp-utils] method table built: ~349000 entries`, `[dispatch] attached to dtt.tjz`, then `[rpc-agent] ready`.

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js`
Expected: timings unchanged from baseline (perf win not yet wired into sender.ts).

- [ ] **Step 6: Commit**

```bash
git add src/rpc-agent/index.ts
git commit -m "refactor(rpc-agent): pre-warm indexes + dispatcher at attach"
```

### Task 1.7: End-of-Phase-1 verification

- [ ] **Step 1: Confirm Phase 1 changes are isolated**

Run: `git log --oneline 954e672..HEAD`
Expected: 6 commits since the spec (1.1, 1.2, 1.3, 1.4, 1.5, 1.6).

- [ ] **Step 2: Confirm full diff size is sensible**

Run: `git diff 954e672..HEAD --stat`
Expected: ~5 files added (core/*.ts + measure-rpc-perf.js), 1 modified (sender.ts ↓ ~90 lines from extracted helpers, index.ts ↑ ~10 lines).

- [ ] **Step 3: Run smoke against attached Dofus**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -H "Content-Type: application/json" \
    -d '{"method":"snapshotDttState","args":[]}' | head -c 200
```
Expected: identical shape to baseline.

---

## Phase 2 — Migrate sender.ts to use core/ (the perf win)

This is the largest mechanical phase. Two pattern replacements applied across the file :
- **Pattern A** : every `Il2Cpp.gc.choose(klass)` becomes `getDtt()` / `getMapRenderer()` / `getSingleton(name)`.
- **Pattern B** : every `pendingMainWork = () => {...}` (with surrounding `inVm(() => new Promise...)` boilerplate) becomes `runOnMainThread(() => {...}, opts)`.

We migrate **by class** (Pattern A) then **by feature group** (Pattern B), with compile + smoke after each batch. Each batch is a separate commit.

### Task 2.1: Migrate Pattern A — `dtt` singleton sites

**Files:**
- Modify: `src/rpc-agent/sender.ts` (multiple call sites)

- [ ] **Step 1: Find all `dtt` gc.choose sites**

Run: `grep -n -B 1 "Il2Cpp.gc.choose(dttKlass)" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: ~25-30 occurrences. Note the line numbers.

- [ ] **Step 2: Add `getDtt` to existing import**

Modify the import at the top of `sender.ts` (the one we set up in Task 1.2) :

```typescript
import {
    inVm,
    getClass,
    buildClassIndex,
    getEnumValues,
    buildMethodTable,
    resolveFrame,
} from "./core/il2cpp-utils";
import { getDtt, getSingleton } from "./core/singletons";
```

- [ ] **Step 3: Apply the replacement pattern**

For each occurrence, the surrounding code looks like :
```typescript
const dttKlass = getClass("dtt");
if (!dttKlass) { resolve({ ok: false, reason: "dtt class not found" }); return; }
const dttInsts = Il2Cpp.gc.choose(dttKlass);
if (!dttInsts.length) { resolve({ ok: false, reason: "no dtt instance" }); return; }
const dtt = dttInsts[0]!;  // OR  dttInsts[dttInsts.length - 1]!
```

Replace with :
```typescript
let dtt: Il2Cpp.Object;
try { dtt = getDtt(); }
catch (e) { resolve({ ok: false, reason: String(e).slice(0, 120) }); return; }
```

The `dttKlass` variable is no longer needed at this site. **However**, some sites still need `dttKlass` for `getClass("dtt")` to look up methods or new() instances (e.g., `dttKlass.method("foo")` calls). Keep `getClass("dtt")` calls that are used for class-level access — only replace the `gc.choose` + instance retrieval pair.

- [ ] **Step 4: Compile gate after every ~5 replacements**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors. If errors appear (typo, missed line), fix before continuing.

- [ ] **Step 5: Build gate**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Smoke gate**

Restart agent. Run:
```bash
node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js
```
Expected: `snapshotDttState` and `isAutopilotActive` timings drop from ~500ms to <50ms. **First measurable perf win.**

Diff against baseline :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -d '{"method":"snapshotDttState","args":[]}' | jq '.result.fields | keys' \
    | diff - <(jq '.result.fields | keys' f:/FridaIL2CPPToolkit/tmp/baseline/snapshotDttState.json)
```
Expected: identical key set.

- [ ] **Step 7: Commit**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): migrate dtt singleton sites to getDtt cache

snapshotDttState/isAutopilotActive: ~500ms → <50ms (first perf win)"
```

### Task 2.2: Migrate Pattern A — other singleton sites

Apply the same pattern to remaining `Il2Cpp.gc.choose(...)` sites.

**Files:**
- Modify: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Find remaining gc.choose sites**

Run: `grep -n "Il2Cpp.gc.choose" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: ~38-40 remaining (started at 68, ~30 done in 2.1).

- [ ] **Step 2: Group by class name**

Note from the grep output: which classes appear most ? Likely `MapRenderer`, `dch`, `dun`, `dvi`, `foz`, `eli`, `cwq`, `iee`, etc.

- [ ] **Step 3: Update the import**

Modify import to include any well-known typed accessor needed :

```typescript
import { getDtt, getMapRenderer, getSingleton } from "./core/singletons";
```

- [ ] **Step 4: Apply pattern by class**

For each non-dtt class :

```typescript
// BEFORE
const xKlass = getClass("X");
if (!xKlass) { resolve({ ok: false, reason: "X class not found" }); return; }
const xInsts = Il2Cpp.gc.choose(xKlass);
if (!xInsts.length) { resolve({ ok: false, reason: "no X instance" }); return; }
const x = xInsts[xInsts.length - 1]!;

// AFTER (use typed accessor when available, otherwise generic)
let x: Il2Cpp.Object;
try { x = getMapRenderer(); }      // OR getSingleton("X")
catch (e) { resolve({ ok: false, reason: String(e).slice(0, 120) }); return; }
```

- [ ] **Step 5: Compile gate after each class migrated**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors.

- [ ] **Step 6: Final compile gate**

Run: `grep -c "Il2Cpp.gc.choose" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: 0 (or comment-only references).

- [ ] **Step 7: Build + smoke**

Run: `npm run build && node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js`
Expected: ALL representative RPCs drop to <50ms.

- [ ] **Step 8: Commit**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): migrate remaining singleton sites to core/singletons

All 68 gc.choose calls in sender.ts replaced. Most read RPCs now <50ms."
```

### Task 2.3: Migrate Pattern B — `pendingMainWork` blocks (batch 1: read RPCs)

The current pattern (one of 30+) :
```typescript
export function snapshotDttState(): Promise<{...}> {
    return inVm(() => new Promise((resolve) => {
        let dtt: Il2Cpp.Object;
        try { dtt = getDtt(); }
        catch (e) { resolve({ ok: false, reason: String(e).slice(0,120) }); return; }
        if (!ensureMainThreadDispatcher()) { resolve({ ok: false, reason: "dispatcher fail" }); return; }
        let settled = false;
        const settle = (r: any) => { if (!settled) { settled = true; resolve(r); } };
        pendingMainWork = () => {
            try {
                const fields: Record<string, string> = {};
                // ... read fields ...
                settle({ ok: true, fields });
            } catch (e) {
                settle({ ok: false, reason: String(e).slice(0,120) });
            }
        };
        setTimeout(() => settle({ ok: false, reason: "dispatch timeout" }), 3000);
    }));
}
```

The target shape :
```typescript
export function snapshotDttState() {
    return runOnMainThread(() => {
        const dtt = getDtt();
        const fields: Record<string, string> = {};
        // ... read fields ...
        return { ok: true, fields };
    }, { label: "snapshotDttState", timeoutMs: 3000 });
}
```

**Files:**
- Modify: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Find all `pendingMainWork = () =>` sites**

Run: `grep -n "pendingMainWork = () =>" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: ~25-30 occurrences.

- [ ] **Step 2: Add `runOnMainThread` to imports**

```typescript
import { runOnMainThread } from "./core/dispatch";
```

- [ ] **Step 3: Migrate read-only RPCs first (lower risk)**

Identify the read-only RPCs from grep + nearby `export function ...` :
- `snapshotDttState`
- `getAutopilotDebugState`
- `isAutopilotActive`
- `inspectFozDict`
- `dumpFozPathEnds`
- `inspectIriPath`
- `getInteractivesFast`
- `inspectCapturedIri`
- `snapshotAutopilotState`
- `dumpOutgoingEdges`
- `getNeighborMapIds`

For each, apply the pattern transform :
- Drop the outer `inVm(() => new Promise(...))` wrapper.
- Drop `ensureMainThreadDispatcher` check (handled inside `runOnMainThread`).
- Drop `settled` flag and `setTimeout`.
- Replace the body inside `pendingMainWork = () => { try {...} catch(e) {...} }` with the body of `runOnMainThread(() => { ... return result; }, opts)`.
- The function signature loses the explicit `Promise<>` return type — `runOnMainThread` returns it.

**Migrate one function, compile, then move on.** Do NOT batch-edit. Each function is ~20-50 lines, takes 2-3 min.

- [ ] **Step 4: Compile gate after each function**

Run: `npx tsc --noEmit -p src/rpc-agent`
Expected: 0 errors.

- [ ] **Step 5: Smoke gate after every ~5 functions**

```bash
curl -s -X POST http://localhost:3001/api/call \
    -d '{"method":"snapshotDttState","args":[]}' \
    | diff - f:/FridaIL2CPPToolkit/tmp/baseline/snapshotDttState.json
```
Expected: identical shape (allowing for runtime-changed values).

- [ ] **Step 6: Commit (after first ~5 RPCs migrated)**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): migrate read-only RPCs to runOnMainThread (batch 1)"
```

- [ ] **Step 7: Repeat for remaining read-only RPCs**

Continue until all read-only RPCs use `runOnMainThread`.

- [ ] **Step 8: Final commit for batch**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): migrate remaining read-only RPCs to runOnMainThread"
```

### Task 2.4: Migrate Pattern B — write/native-call RPCs (batch 2)

These RPCs invoke native code (`autoTravelInstant`, `loadMapNative`, `sendFakeIri`, etc.). They have side effects and need careful migration.

**Files:**
- Modify: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Identify the remaining `pendingMainWork` sites**

Run: `grep -n "pendingMainWork = () =>" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: only side-effecting RPCs left.

- [ ] **Step 2: Migrate one at a time**

Same pattern as 2.3. **Watch for these gotchas** :
- Some RPCs use `pendingMainWork = ` chained via `scheduleMainThread` (e.g., catalog texture export). For those, `runOnMainThread` is the equivalent — just queue separately, the dispatcher batches them.
- Some RPCs assemble work-then-resolve in a different order (e.g., set up a hook, then schedule a trigger). Keep the order ; `runOnMainThread` only replaces the "schedule on main thread" piece.

- [ ] **Step 3: For each migrated function, smoke-test the actual side effect**

For `autoTravelInstant` : call it with a known mapId, verify the player walks. Compare to pre-refactor behavior.
For `sendFakeIri` : trigger an arm + call, verify packet gets emitted (in the dofus-app socket panel).

- [ ] **Step 4: Final grep check**

Run: `grep -c "pendingMainWork = () =>" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: 0.

Also verify the legacy module-level state can be removed :
Run: `grep -n "let pendingMainWork\|let mainThreadDispatcher\|function ensureMainThreadDispatcher\|export function scheduleMainThread" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: lines exist.

- [ ] **Step 5: Delete dead infrastructure**

Remove these now-unused declarations from `sender.ts` :
- `let mainThreadDispatcher: any = null;`
- `let pendingMainWork: (() => void) | null = null;`
- `let mainThreadDispatcherFireCount = 0;`
- `let mainThreadDispatcherWorkCount = 0;`
- `function ensureMainThreadDispatcher(): boolean { ... }`
- `export function scheduleMainThread(work) { ... }`
- `export function getMainThreadDispatcherStats() { ... }` — but check call sites first :

Run: `grep -rn "scheduleMainThread\|getMainThreadDispatcherStats" f:/FridaIL2CPPToolkit/src/`
If `catalog.ts` or other modules import `scheduleMainThread`, update them to use `runOnMainThread` from `core/dispatch.ts`. Replace `getMainThreadDispatcherStats` exports with `getDispatcherStats` re-export :

```typescript
// at top of sender.ts after imports
export { getDispatcherStats as getMainThreadDispatcherStats } from "./core/dispatch";
```

This keeps the existing RPC name working.

- [ ] **Step 6: Compile + build + smoke**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`
Expected: 0 errors.

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js`
Expected: ALL RPCs <50ms ; concurrent burst <100ms total.

- [ ] **Step 7: Commit**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): finish runOnMainThread migration; drop legacy dispatcher

- All 30+ pendingMainWork blocks replaced with runOnMainThread
- Legacy module-level state and ensureMainThreadDispatcher deleted
- getMainThreadDispatcherStats kept as re-export from core/dispatch
- Concurrent RPC bursts now batch in one dtt.tjz tick instead of cascading"
```

### Task 2.5: Migrate field-ops sites

`nullDttField`, `setIntField`, `probeStaticField`, `writeDeiz`, `writeDpglState`, `nullFozField` — these are now thin wrappers over `core/field-ops.ts`.

**Files:**
- Modify: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Update field-ops wrapper bodies**

Add to imports :
```typescript
import {
    readField, writeField, nullField,
    readStaticField, writeStaticField, nullStaticField,
    readFieldPath,
} from "./core/field-ops";
```

For each wrapper, replace the body. Example :

```typescript
// BEFORE — ~30 lines with type-dispatch
export function nullDttField(fieldName: string) {
    return runOnMainThread(() => {
        const dtt = getDtt();
        const f = (dtt as any).field(fieldName);
        const t = f.type?.name ?? "";
        if (t === "Boolean") f.value = false;
        else if (t === "Int32") f.value = 0;
        // ... etc ...
        return { ok: true, fieldName };
    }, { label: "nullDttField" });
}

// AFTER — 5 lines
export function nullDttField(fieldName: string) {
    return runOnMainThread(() => {
        nullField(getDtt(), fieldName);
        return { ok: true, fieldName };
    }, { label: "nullDttField" });
}
```

Similar for `setIntField` (becomes `writeField` with explicit number cast), `probeStaticField` (becomes `readStaticField` + optional `nullStaticField`), `probeFozCts` (becomes `readFieldPath` + optional `writeField`).

- [ ] **Step 2: Compile + build + smoke**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`
Expected: 0 errors.

Run: `curl -s -X POST http://localhost:3001/api/call -d '{"method":"probeStaticField","args":["foz","dpgi"]}' `
Expected: returns the dpgi value (`<null>` on healthy session).

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): use core/field-ops for field-manipulation RPCs"
```

### Task 2.6: End-of-Phase-2 perf measurement

- [ ] **Step 1: Run the full measurement**

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js > f:/FridaIL2CPPToolkit/tmp/baseline/perf-after-phase2.txt`

- [ ] **Step 2: Compare**

Run: `diff f:/FridaIL2CPPToolkit/tmp/baseline/perf-before.txt f:/FridaIL2CPPToolkit/tmp/baseline/perf-after-phase2.txt`
Expected: 10-30× improvement on the read RPCs. Document the exact numbers in the next commit message.

- [ ] **Step 3: Verify game responsiveness manually**

With Dofus visible, run a burst from the dofus-app coverage panel (or 5 rapid curl calls). Watch the game window — there should be no perceptible freeze.

---

## Phase 3 — Decompose sender.ts into features/

Each feature module is one self-contained extraction. Order from smallest (lowest risk) to largest. After each, `sender.ts` is shorter and the new file holds the moved exports.

### Task 3.1: Extract `features/zaap.ts`

**Files:**
- Create: `src/rpc-agent/features/zaap.ts`
- Modify: `src/rpc-agent/sender.ts` (remove moved code, add re-export)
- Modify: `src/rpc-agent/rpc-methods.ts` (add zaap import)

- [ ] **Step 1: Identify the zaap-related exports**

Run: `grep -n "^export function" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts | grep -i zaap`
Expected: `zaapTeleport`, `listKnownZaaps`. Also `scanZaapCandidates` lives in introspection — check.

Run: `grep -n -A 1 "^export function" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts | grep -B 1 -i "zaap"`
Note line ranges for each function.

- [ ] **Step 2: Create the new file with the moved code**

`src/rpc-agent/features/zaap.ts` :

```typescript
// Zaap teleport via in-game iee → gyr packet sequence.
// Requires player on a zaap cell ; works for any cached unlocked destination.
import "frida-il2cpp-bridge";
import { runOnMainThread } from "../core/dispatch";
import { getDtt, getSingleton } from "../core/singletons";
import { getClass, getEnumValues } from "../core/il2cpp-utils";

// PASTE the body of zaapTeleport here (from sender.ts), updated to use
// runOnMainThread + getDtt + getSingleton + getClass.

// PASTE the body of listKnownZaaps here.
```

Read each function from `sender.ts`, paste it, **then update its body** to use the core helpers (`runOnMainThread`, `getDtt`, etc.) — no more inline `gc.choose`, no more `pendingMainWork`. Most of the migration was done in Phase 2 ; here we just move the code verbatim.

- [ ] **Step 3: Remove the moved exports from sender.ts**

Delete the function definitions. Add a re-export so `rpc-methods.ts` doesn't break :

```typescript
// at bottom of sender.ts (or grouped at top after imports)
export { zaapTeleport, listKnownZaaps } from "./features/zaap";
```

- [ ] **Step 4: Compile + build**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`
Expected: 0 errors.

- [ ] **Step 5: Smoke test**

Run :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -d '{"method":"listKnownZaaps","args":[]}' \
    | jq '.result.count'
```
Expected: a number > 0 (matches pre-refactor count).

- [ ] **Step 6: Commit**

```bash
git add src/rpc-agent/features/zaap.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): extract features/zaap.ts"
```

### Task 3.2: Extract `features/introspection.ts`

**Files:**
- Create: `src/rpc-agent/features/introspection.ts`
- Modify: `src/rpc-agent/sender.ts`

Functions to move : `describeClass`, `findClassesContaining`, `findMethodsWithType`, `findClassesWithFieldType`, `scanArrowCandidates`, `scanZaapCandidates`, `callOnLive`, `callStaticOnClass`, `resolveAddress`.

- [ ] **Step 1: Confirm the function list**

Run: `grep -n "^export function \(describeClass\|findClassesContaining\|findMethodsWithType\|findClassesWithFieldType\|scanArrowCandidates\|scanZaapCandidates\|callOnLive\|callStaticOnClass\|resolveAddress\)" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: 9 lines.

- [ ] **Step 2: Create `features/introspection.ts`**

```typescript
// IL2CPP introspection RPCs — class/method/field discovery, dynamic invocation,
// stack-frame resolution. Used by Claude/curl to explore unknown classes.
import "frida-il2cpp-bridge";
import { runOnMainThread } from "../core/dispatch";
import { getSingleton } from "../core/singletons";
import { getClass, resolveFrame } from "../core/il2cpp-utils";

// Move the 9 functions here, updating bodies to use core/* helpers.
```

Move each function body. Check for shared helpers between them (e.g., a `ScanHit` interface) — move those too.

- [ ] **Step 3: Update `sender.ts` to re-export**

```typescript
export {
    describeClass, findClassesContaining, findMethodsWithType,
    findClassesWithFieldType, scanArrowCandidates, scanZaapCandidates,
    callOnLive, callStaticOnClass, resolveAddress,
} from "./features/introspection";
```

- [ ] **Step 4: Compile + build + smoke**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`

Smoke :
```bash
curl -s -X POST http://localhost:3001/api/call \
    -d '{"method":"describeClass","args":["dtt"]}' | jq '.result.fields | length'
```
Expected: a number > 0 matching pre-refactor.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/features/introspection.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): extract features/introspection.ts"
```

### Task 3.3: Extract `features/mapload.ts`

**Files:**
- Create: `src/rpc-agent/features/mapload.ts`
- Modify: `src/rpc-agent/sender.ts`

Functions to move : `loadMapNative`, `snapshotDttState`, `listAllDttInstances`, `enterHavreSac`, `triggerKwd`, `getNeighborMapIds`.

- [ ] **Step 1: Move the functions to a new file using the same pattern as 3.1/3.2**

Replicate the structure : module-level imports from `core/`, paste functions, update bodies to use core helpers (most already did in Phase 2 — this is mostly a code move).

- [ ] **Step 2: Re-export in sender.ts**

```typescript
export {
    loadMapNative, snapshotDttState, listAllDttInstances,
    enterHavreSac, triggerKwd, getNeighborMapIds,
} from "./features/mapload";
```

- [ ] **Step 3: Compile + build + smoke**

```bash
curl -s -X POST http://localhost:3001/api/call \
    -d '{"method":"snapshotDttState","args":[]}' | jq '.result.ok'
```
Expected: `true`.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/features/mapload.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): extract features/mapload.ts"
```

### Task 3.4: Decide: `features/packets.ts` or merge into `network.ts` ?

This resolves spec §10.1. The decision determines the next task's structure.

**Files:**
- Read-only inspection of `network.ts`.

- [ ] **Step 1: Inspect network.ts**

Run: `wc -l f:/FridaIL2CPPToolkit/src/rpc-agent/network.ts`
Expected: 1276 lines (per earlier survey).

Run: `grep -c "^export " f:/FridaIL2CPPToolkit/src/rpc-agent/network.ts`
Note count.

- [ ] **Step 2: Estimate post-merge size**

Run: `grep -c "^export function" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts | head -1`
Then count packet RPCs in sender.ts (sendFakeIri/Isu/Isp/Jmw/Isl, armCaptureIri, armCaptureSequence, getCapturedSequence, armCaptureTransition, getCapturedTransitionStatus, armBlockNextIsu, inspectIriPath, replayIriWithExtra, executeFakeTransition, replayTransitionIri, replayIriIsu, replayTransition, inspectCapturedIri, replayCapturedIri, sendFakeJrt, getOutgoingLog/Stacks, clearOutgoingLog/Stacks, installOutgoingHook, installIncomingHook, getIncomingLog, clearIncomingLog, getIrxCapturedEntities, clearIrxCapturedEntities, getCombinedLog, setSocketBroadcastSkip, getInteractivesFast).

Estimate added lines : ~800-1100. Total post-merge : ~2000-2400 lines.

- [ ] **Step 3: Decide and document**

If post-merge < 2000 lines → **merge into `network.ts`** (one packet hub).
Otherwise → create `features/packets.ts` (separate high-level vs low-level).

Document the choice in the commit message of the next task.

### Task 3.5: Extract / merge packet RPCs

Apply the decision from 3.4.

**Files** (if merging into network.ts):
- Modify: `src/rpc-agent/network.ts`
- Modify: `src/rpc-agent/sender.ts`

**Files** (if separate):
- Create: `src/rpc-agent/features/packets.ts`
- Modify: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Move the packet exports + their module-level state**

Critical : the packet RPCs share a lot of module-level state in sender.ts :
- `outgoingLog`, `incomingLog`, `irxCapturedEntities`, `capturedSeq`, `capturedTransitionClones`
- `traceClsSet`, `traceAll`, `xbeHookInstalled`, `fzkHookInstalled`
- `socketBroadcastSkip`, `FIELD_EXTRACT_CLASSES`
- `captureSeqMaxCount`, `captureClonesArmed`, `blockNextIsuArmed`
- Helpers : `snapshotFields`, `snapshotFieldsDeep`

Move ALL of this to the destination file. Verify no other module references these (grep first).

- [ ] **Step 2: Update re-exports in sender.ts**

Re-export all moved RPC names so `rpc-methods.ts` resolution stays unchanged.

- [ ] **Step 3: Compile + build + smoke**

Smoke : trigger an outgoing-hook capture from the dofus-app socket panel. Verify packets still flow.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/network.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): merge packet RPCs into network.ts (or extract features/packets.ts)

Resolves spec §10.1 — packet RPCs live in [chosen location] because [size justification]."
```

### Task 3.6: Extract `features/autopilot.ts`

**Files:**
- Create: `src/rpc-agent/features/autopilot.ts`
- Modify: `src/rpc-agent/sender.ts`

Functions to move : `autoTravelInstant`, `autoTravelInstantNative`, `autoTravelReuseDch`, `abortAutoTravel`, `isAutopilotActive`, `getAutopilotDebugState`, `snapshotAutopilotState`, `hookAutopilotDone`, `unhookAutopilotDone`, `hookBbdArgs`, `unhookBbdArgs`, `hookAutopilot`, `unhookAutopilot`, `getAutopilotHits`, `clearAutopilotHits`, `traceAutopilotChain`, `untraceAutopilotChain`, `getAutopilotTrace`, `traceAutopilotMinimal`, `hookSolverProbes`, `unhookSolverProbes`, `getSolverProbeHits`, `hookBbdEntry`, `unhookBbdEntry`, `getBbdEntries`, `clearBbdEntries`, `megaAutopilotReset`, `dttBbdRaw`.

Plus shared module state : `cachedLiveDun`, `cachedLiveDvi` (autopilot-cache fields), `autopilotHits`, `bbdEntries`, `solverProbeHits`, `traceHits`, hook-state booleans, traced-method registries.

- [ ] **Step 1: Move all exports + state**

Same pattern : create the file, move the code, update bodies to use core helpers.

- [ ] **Step 2: Re-export from sender.ts**

- [ ] **Step 3: Compile + build + smoke**

Critical smoke : `autoTravelInstant(known-reachable-mapId)` must engage the in-game autopilot. Watch player walk.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/features/autopilot.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): extract features/autopilot.ts"
```

### Task 3.7: Extract `features/pathfinder.ts`

**Files:**
- Create: `src/rpc-agent/features/pathfinder.ts`
- Modify: `src/rpc-agent/sender.ts`

Functions to move : `resetPathfinderState`, `probeFozCts`, `probeStaticField`, `inspectFozDict`, `fullFozReset`, `createFreshFoz`, `callFozCtor`, `callFozBgtt`, `clearStuckCallbacks`, `nullFozField`, `writeDeiz`, `writeDpglState`, `clearDeizViaCwi`, `clearFozOpenClosed`, `dumpFozPathEnds`, `triggerWalkFromFozPath`, `dumpOutgoingEdges`, `injectBfsPathAndWalk`, `replaceEliInstance`, `hookFozWatcher`, `unhookFozWatcher`, `getFozHits`, `clearFozHits`, `hookEliWatcher`, `unhookEliWatcher`, `getEliHits`, `clearEliHits`, `hookDeizWatcher`, `unhookDeizWatcher`, `getDeizHits`, `clearDeizHits`, `invokeEliCallback`, `dispatchBaoiWithStuckCallback`, `nullDttField`, `setIntField`, `getInteractivesFast` (if not already in mapload), and the BFS reachability helpers (`isReachableMapIds`).

Plus state : `_wgAdj`, `_wgUidToMid`, `_wgMidToUids` (worldgraph BFS cache), watcher hook-state, captured hits buffers.

- [ ] **Step 1: Move all exports + state**

This is the LARGEST feature module (~1500 lines). Take it slow, compile after every ~5 functions moved.

- [ ] **Step 2: Re-export from sender.ts**

- [ ] **Step 3: Compile + build + smoke**

Critical smokes :
- `dumpOutgoingEdges` returns a non-empty adjacency map.
- `probeStaticField("foz","dpgi")` returns the field value.
- `resetPathfinderState` runs without throwing.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/features/pathfinder.ts src/rpc-agent/sender.ts
git commit -m "refactor(rpc-agent): extract features/pathfinder.ts"
```

### Task 3.8: End-of-Phase-3 audit

- [ ] **Step 1: Confirm sender.ts is now empty (or only re-exports)**

Run: `grep -c "^export function" f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: 0 (the file should now contain only re-export `export { … } from "./features/X"` statements + maybe a module-level comment).

Run: `wc -l f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`
Expected: <100 lines (just imports + re-exports).

- [ ] **Step 2: Verify dependency rule**

Run :
```bash
grep -n "Il2Cpp.gc.choose" f:/FridaIL2CPPToolkit/src/rpc-agent/features/*.ts
```
Expected: 0 matches in features/.

Run :
```bash
grep -n "pendingMainWork = " f:/FridaIL2CPPToolkit/src/rpc-agent/features/*.ts
```
Expected: 0 matches in features/.

The architectural invariant from the spec is now enforced by the file structure.

---

## Phase 4 — Drop sender.ts

### Task 4.1: Update rpc-methods.ts to import directly from features/

**Files:**
- Modify: `src/rpc-agent/rpc-methods.ts`

- [ ] **Step 1: Read current rpc-methods.ts**

(Already inspected — imports `senderRpc` from `./sender`.)

- [ ] **Step 2: Replace senderRpc with feature-module imports**

```typescript
// src/rpc-agent/rpc-methods.ts
import * as searchRpc from "./search";
import * as explorerRpc from "./explorer";
import * as hooksRpc from "./hooks";
import * as instanceOpsRpc from "./instance-ops";
import * as networkRpc from "./network";
import * as watchlistRpc from "./watchlist";
import * as scannerRpc from "./scanner";
import * as inspectorRpc from "./inspector";
import * as diffRpc from "./diff";
import * as stacktraceRpc from "./stacktrace";
import * as mapstateRpc from "./mapstate";
import * as catalogRpc from "./catalog";
// New feature modules — replace senderRpc.
import * as autopilotRpc from "./features/autopilot";
import * as pathfinderRpc from "./features/pathfinder";
import * as maploadRpc from "./features/mapload";
import * as zaapRpc from "./features/zaap";
import * as introspectionRpc from "./features/introspection";
// (packets module imported only if Task 3.5 created features/packets.ts ;
// otherwise its exports are already in networkRpc.)
// import * as packetsRpc from "./features/packets";
// Dispatch stats from core/ — exposed as RPC for UI / smoke tests.
import { getDispatcherStats } from "./core/dispatch";
import { invalidateAllSingletons, getSingletonStats } from "./core/singletons";

type AllRpc = typeof searchRpc & typeof explorerRpc & typeof hooksRpc
            & typeof instanceOpsRpc & typeof networkRpc & typeof watchlistRpc
            & typeof scannerRpc & typeof inspectorRpc & typeof diffRpc
            & typeof stacktraceRpc & typeof mapstateRpc & typeof catalogRpc
            & typeof autopilotRpc & typeof pathfinderRpc & typeof maploadRpc
            & typeof zaapRpc & typeof introspectionRpc
            & {
                getDispatcherStats: typeof getDispatcherStats;
                invalidateSingletons: typeof invalidateAllSingletons;
                getSingletonStats: typeof getSingletonStats;
            };

export function getRpcMethods(): AllRpc {
    return {
        ...searchRpc,
        ...explorerRpc,
        ...hooksRpc,
        ...instanceOpsRpc,
        ...networkRpc,
        ...watchlistRpc,
        ...scannerRpc,
        ...inspectorRpc,
        ...diffRpc,
        ...stacktraceRpc,
        ...mapstateRpc,
        ...catalogRpc,
        ...autopilotRpc,
        ...pathfinderRpc,
        ...maploadRpc,
        ...zaapRpc,
        ...introspectionRpc,
        getDispatcherStats,
        invalidateSingletons: invalidateAllSingletons,
        getSingletonStats,
    } as AllRpc;
}
```

- [ ] **Step 3: Compile + build**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`
Expected: 0 errors.

- [ ] **Step 4: Confirm RPC count is unchanged**

Restart agent. Watch the `[rpc-agent] ready. Exposed methods: ...` log. Compare the alphabetically-sorted method list to the pre-refactor list (capture from `tmp/baseline/` if not done).

If methods are missing : the re-export in `sender.ts` was the only path for some, and we missed importing the corresponding `features/*` from `rpc-methods.ts`. Fix.

- [ ] **Step 5: Smoke gate**

```bash
node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js
```
Expected: same perf as end of Phase 2.

- [ ] **Step 6: Commit**

```bash
git add src/rpc-agent/rpc-methods.ts
git commit -m "refactor(rpc-agent): wire feature modules + core/ stats into rpc-methods"
```

### Task 4.2: Delete sender.ts

**Files:**
- Delete: `src/rpc-agent/sender.ts`

- [ ] **Step 1: Verify nothing else imports from sender**

Run: `grep -rn "from \"./sender\"\|from \"\\./sender\"" f:/FridaIL2CPPToolkit/src/`
Expected: 0 matches (rpc-methods.ts was updated in 4.1).

Run: `grep -rn "rpc-agent/sender" f:/FridaIL2CPPToolkit/dofus-app/`
Expected: 0 matches (dofus-app uses HTTP RPC names, not file paths).

- [ ] **Step 2: Delete the file**

Run: `rm f:/FridaIL2CPPToolkit/src/rpc-agent/sender.ts`

- [ ] **Step 3: Compile + build + smoke**

Run: `npx tsc --noEmit -p src/rpc-agent && npm run build`
Expected: 0 errors.

Smoke : restart agent, run `measure-rpc-perf.js`, run a manual coverage panel test in the dofus-app UI.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(rpc-agent): delete sender.ts; refactor complete

Final structure:
- src/rpc-agent/core/ : dispatch, singletons, il2cpp-utils, field-ops
- src/rpc-agent/features/ : autopilot, pathfinder, mapload, zaap, introspection
                          (+ packets if separate, else merged into network.ts)
- All gc.choose calls live behind core/singletons sticky cache
- All main-thread work goes through core/dispatch.runOnMainThread queue
- 500ms-per-RPC freeze eliminated"
```

### Task 4.3: Final perf measurement + comparison

- [ ] **Step 1: Run final perf script**

Run: `node f:/FridaIL2CPPToolkit/dofus-app/scripts/measure-rpc-perf.js > f:/FridaIL2CPPToolkit/tmp/baseline/perf-final.txt`

- [ ] **Step 2: Three-way diff**

Run :
```bash
echo "=== BEFORE (pre-refactor) ===" && cat f:/FridaIL2CPPToolkit/tmp/baseline/perf-before.txt
echo "=== AFTER PHASE 2 ==="          && cat f:/FridaIL2CPPToolkit/tmp/baseline/perf-after-phase2.txt
echo "=== FINAL (post-Phase 4) ==="   && cat f:/FridaIL2CPPToolkit/tmp/baseline/perf-final.txt
```

Expected : final and Phase 2 are similar (Phases 3-4 don't add perf, just structure). Both show >10× improvement vs before.

- [ ] **Step 3: Manual game responsiveness check**

With Dofus open and visible, mount the dofus-app coverage panel. Trigger a coverage-plan run. Watch for any frame drops in the Dofus window during the burst of RPCs. **There should be none.**

If freezes still appear : investigate via `getDispatcherStats` (look at `queueHighWaterMark` — if >5, the per-tick budget is being hit ; consider raising or batching panel polls).

- [ ] **Step 4: Update spec status**

Edit `docs/superpowers/specs/2026-04-28-rpc-agent-core-refactor-design.md` :
- Change `**Status** : draft (awaiting user review)` → `**Status** : implemented YYYY-MM-DD`.
- Add a "Measured Results" section at the bottom with the actual numbers from `perf-final.txt`.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-04-28-rpc-agent-core-refactor-design.md
git commit -m "docs(specs): mark RPC agent refactor as implemented; record measured perf"
```

---

## Self-Review Checklist (run before declaring done)

- [ ] All 68 `Il2Cpp.gc.choose` calls eliminated from `features/*` and `sender.ts` (sender.ts deleted in 4.2). `core/singletons.ts` has the only one.
- [ ] All 30+ `pendingMainWork = ...` blocks gone. Only `core/dispatch.ts` references the dispatch internals.
- [ ] `sender.ts` deleted (or contains 0 export functions).
- [ ] Pre-warm at attach : log shows `class index built` + `method table built` BEFORE the first RPC log.
- [ ] No regression in RPC count : the alphabetically sorted list at agent boot matches the pre-refactor list (modulo the new `getDispatcherStats`, `invalidateSingletons`, `getSingletonStats` additions).
- [ ] Performance : trivial RPCs <50ms wall time. Burst of 5 reads <100ms total.
- [ ] No regression in dofus-app UI : every panel that worked pre-refactor still works post-refactor.
- [ ] Spec is marked `implemented` with measured numbers.

---

## Risk & Rollback

Each phase commit is independent. If a phase breaks something :
- **Rollback Phase 4** (delete sender.ts) : `git revert <commit>` — restores sender.ts as a thin re-export.
- **Rollback Phase 3** (a feature extraction) : `git revert <commit>` — moves functions back to sender.ts.
- **Rollback Phase 2** (perf migration) : `git revert <range>` — restores original `gc.choose` + `pendingMainWork` patterns. Phase 1 stays.
- **Rollback Phase 1** (core/) : `git revert <range>` — deletes `core/`. Original sender.ts is fully restored.

The user can also stop after Phase 2 and ship (the perf win lands without the file decomposition). Phases 3-4 are pure structure.

---

## Open Issues (resolve during implementation)

1. **Frida unload hook API** (Task 1.6 step 2) : verify whether `Script.bindWeak` or `Script.unload.connect` is the correct symbol for the Frida version in use. Test by triggering `/api/reload` and confirming `[singletons] cache cleared` appears.

2. **Cross-module shared state** (Task 3.x) : when moving functions into a feature module, audit module-level `let foo = ...` declarations. If two functions in DIFFERENT future feature modules reference the same `let`, the state should move to `core/` (or be split per feature). Discover at compile-error time.

3. **Catalog texture export uses scheduleMainThread** : if `catalog.ts` imports `scheduleMainThread` from sender.ts, it must switch to `runOnMainThread` from `core/dispatch`. Detected in Task 2.4 step 5.

4. **getMainThreadDispatcherStats backwards-compat** : the dofus-app UI may call this RPC by name. Task 2.4 step 5 keeps a re-export, but verify the UI panel that reads it still works (likely `panels/connection.ts` or `panels/socket.ts`).

5. **packets.ts merge decision** (Task 3.4) : the size threshold of 2000 lines for network.ts is a guideline. The implementer can override based on cohesion judgment.
