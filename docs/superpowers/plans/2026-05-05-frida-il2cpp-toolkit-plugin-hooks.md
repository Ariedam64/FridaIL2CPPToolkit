# Plugin Hooks (v1.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first real consumer of the Toolkit Core's Plugin API — a Hooks plugin that lets the user install/manage Frida method hooks via a tree sidebar and observe live hits in a webview log (Stream + Summary).

**Architecture:** Agent-side execution (no per-hit RPC roundtrip). The agent's `rpc-agent/hooks.ts` gains `installHook` / `revertHook` / `listInstalledHooks` / `clearAllHooks`; each hit calls Frida `send()` with a typed payload. The extension subscribes via a new `coreApi.onAgentMessage` event, dispatches to a `HookEventBus`, and routes to the webview Stream/Summary. Hook definitions persist per-profile via the existing `DiskPluginStorage`, **disarmed** at attach.

**Tech Stack:** TypeScript, Frida (frida-il2cpp-bridge + frida-compile), VSCode extension API, vitest for unit tests on pure modules. Existing toolkit core in `dofus-app/vscode-extension/src/core/`. New plugin lives in `dofus-app/vscode-extension/src/plugins/hooks/`.

**Spec:** [`docs/superpowers/specs/2026-05-05-frida-il2cpp-toolkit-plugin-hooks-design.md`](../specs/2026-05-05-frida-il2cpp-toolkit-plugin-hooks-design.md)

---

## File Structure

### New files

| Path | Responsibility |
|------|----------------|
| `src/lib/stack-trace.ts` | Lazy-build IL2CPP method address table; resolve a backtrace into `Cls.method+0xoff` strings. Factored out of `sender.ts`. |
| `src/rpc-agent/hook-types.ts` | `HookTemplate`, `HookSpec`, `InstalledHook`, `HookEvent` shared shapes (also re-imported plugin-side). |
| `dofus-app/vscode-extension/src/plugins/hooks/types.ts` | Plugin-side mirror of the agent types + `StoredHook` (the disk shape with `id` and `installedHookId`). |
| `dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts` | Pure `validateHookSpec(spec)` returning `{ ok: true } \| { ok: false; reason: string }`. |
| `dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts` | CRUD + persistence + install/uninstall via RPC. Owns `StoredHook[]` state. |
| `dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts` | Subscribes to `coreApi.onAgentMessage`, filters `type === "hook-event"`, multi-cast to listeners + ring buffer. |
| `dofus-app/vscode-extension/src/plugins/hooks/hooks-tree.ts` | `HooksTreeProvider` (TreeDataProvider). |
| `dofus-app/vscode-extension/src/plugins/hooks/commands.ts` | `registerHookCommands({ store, treeProvider, logPanel, coreApi })`. |
| `dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts` | `HookLogPanel` — webview Stream + Summary tabs. |
| `dofus-app/vscode-extension/src/plugins/hooks/index.ts` | Plugin entry: `activateHooksPlugin(coreApi, ctx)`. |
| `dofus-app/vscode-extension/test/plugins/hooks/hook-spec-validation.test.ts` | Unit tests for validation. |
| `dofus-app/vscode-extension/test/plugins/hooks/hook-store.test.ts` | Unit tests for store + persistence (uses tmp dir + fake RPC). |
| `dofus-app/vscode-extension/test/plugins/hooks/hook-event-bus.test.ts` | Unit tests for event filtering + ring buffer. |

### Modified files

| Path | Change |
|------|--------|
| `src/rpc-agent/hooks.ts` | Add `installHook` / `revertHook` / `listInstalledHooks` / `clearAllHooks`. |
| `src/rpc-agent/sender.ts` | Replace local `methodTable` / `buildIl2cppMethodTable` / `resolveFrame` with imports from `lib/stack-trace.ts`. |
| `src/lib/index.ts` | Re-export `./stack-trace`. |
| `dofus-app/vscode-extension/src/core/api.ts` | Add `onAgentMessage: vscode.Event<unknown>` to `CoreApi` + `CoreApiDeps`. |
| `dofus-app/vscode-extension/src/core/frida-direct.ts` | Expose an `EventEmitter<unknown>` fed from `script.message`. |
| `dofus-app/vscode-extension/src/extension.ts` | Plumb message emitter into `createCoreApi`; call `activateHooksPlugin`. |
| `dofus-app/vscode-extension/package.json` | Add `fridaHooks` view, `frida.hooks.*` commands, context menus. |
| `dofus-app/vscode-extension/SMOKE-TEST.md` | Add hooks test sequence. |

---

## Task 1: Factor stack-trace helper

**Files:**
- Create: `src/lib/stack-trace.ts`
- Modify: `src/lib/index.ts`
- Modify: `src/rpc-agent/sender.ts:88-160` (drop the local methodTable + helpers, import from lib)

- [ ] **Step 1: Create stack-trace module**

Write `src/lib/stack-trace.ts`:

```ts
// Lazy-build an IL2CPP method address table and resolve raw stack frames
// to "Cls.method+0xoff" strings. Factored out of sender.ts so the Hooks
// plugin (and any future module) can capture stack traces without
// duplicating the ~349k-entry table.

import "frida-il2cpp-bridge";

interface MethodRef { addrHex: string; cls: string; name: string; }

let _methodTable: MethodRef[] | null = null;

function hexPad(p: NativePointer): string {
    const s = p.toString();
    return (s.startsWith("0x") ? s.slice(2) : s).padStart(16, "0");
}

function ensureTable(): MethodRef[] {
    if (_methodTable) return _methodTable;
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
    _methodTable = list;
    console.log(`[stack-trace] method table built: ${list.length} entries`);
    return list;
}

/** Build (or return cached) method-address table size. Useful for warm-up. */
export function buildMethodTable(): number {
    return ensureTable().length;
}

/** Drop the cached table — next call rebuilds. */
export function invalidateMethodTable(): void {
    _methodTable = null;
}

/** Resolve a single frame pointer to "Cls.method+0xoff" or "0xADDR" if unknown. */
export function resolveFrame(frame: NativePointer): string {
    const table = ensureTable();
    const addr = hexPad(frame);
    let lo = 0, hi = table.length - 1, found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = table[mid].addrHex;
        if (cmp <= addr) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    if (found < 0) return `0x${addr}`;
    const ref = table[found];
    const off = (parseInt(addr, 16) - parseInt(ref.addrHex, 16)).toString(16);
    return `${ref.cls}.${ref.name}+0x${off}`;
}

/** Capture a backtrace from a Frida CpuContext, resolved to symbolic frames. */
export function getStackFrames(ctx: CpuContext, maxDepth: number = 20): string[] {
    const bt = Thread.backtrace(ctx, Backtracer.ACCURATE);
    const out: string[] = [];
    for (let i = 0; i < Math.min(bt.length, maxDepth); i++) {
        out.push(resolveFrame(bt[i]));
    }
    return out;
}
```

- [ ] **Step 2: Re-export from lib barrel**

Edit `src/lib/index.ts`:

```ts
export * from "./util";
export * from "./search";
export * from "./analyze";
export * from "./dump";
export * from "./hook";
export * from "./patch";
export * from "./invoke";
export * from "./instances";
export * from "./memory";
export * from "./stack-trace";
```

- [ ] **Step 3: Strip duplicates from sender.ts**

In `src/rpc-agent/sender.ts`, find the block at lines ~88–160 (`interface MethodRef`, `let methodTable`, `hexPad`, `buildIl2cppMethodTable`, `resolveFrame`). Replace it with:

```ts
import { buildMethodTable, resolveFrame, getStackFrames } from "../lib/stack-trace";

// (delete `interface MethodRef`, `methodTable`, `hexPad`, `buildIl2cppMethodTable`, `resolveFrame`)
```

Then in callers within sender.ts:
- Replace `buildIl2cppMethodTable()` with `buildMethodTable()`.
- `resolveFrame(...)` calls already match the new signature.

- [ ] **Step 4: Build the agent**

Run: `npm run build:rpc`
Expected: clean exit, `build/rpc-agent.js` regenerated.

- [ ] **Step 5: Build standalone tools (sanity check the lib re-export)**

Run: `npm run build:hook && npm run build:dump`
Expected: clean exit.

- [ ] **Step 6: Commit**

```bash
git add src/lib/stack-trace.ts src/lib/index.ts src/rpc-agent/sender.ts
git commit -m "$(cat <<'EOF'
refactor(lib): factor methodTable + resolveFrame into stack-trace.ts

Hoisted out of sender.ts so the Hooks plugin (and future modules)
can capture IL2CPP backtraces without duplicating the ~349k-entry
method-address table. Same lazy-build semantics, same output
format ("Cls.method+0xoff").

New API:
  buildMethodTable(): number
  invalidateMethodTable(): void
  resolveFrame(ptr): string
  getStackFrames(ctx, maxDepth=20): string[]
EOF
)"
```

---

## Task 2: Hook types (agent + plugin shared shape)

**Files:**
- Create: `src/rpc-agent/hook-types.ts`

- [ ] **Step 1: Write the types file**

```ts
// Shared types between the agent's hooks RPC surface and the plugin
// that consumes them. Plugin-side imports a copy in
// `dofus-app/vscode-extension/src/plugins/hooks/types.ts` (Frida agents
// and the VSCode extension live in different tsconfig roots, hence
// the duplication — kept in sync manually; both files are tiny).

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    /** Required for `force-return`. Stringified value coerced agent-side. */
    forceReturnValue?: unknown;
    /** Used by `log-stack`. How many initial hits get a backtrace. Default 5. */
    stackCaptureCount?: number;
}

export interface InstalledHook {
    hookId: string;
    spec: HookSpec;
    installedAt: number;
}

export interface HookEvent {
    type: "hook-event";
    hookId: string;
    ts: number;
    self: string | null;
    args: string[];
    retval: string | null;
    error?: string;
    stackFrames?: string[];
}
```

- [ ] **Step 2: Build the agent**

Run: `npm run build:rpc`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/hook-types.ts
git commit -m "feat(rpc-agent): add hook-types.ts (HookSpec/InstalledHook/HookEvent)"
```

---

## Task 3: Implement installHook / revertHook for `log` and `noop` templates

**Files:**
- Modify: `src/rpc-agent/hooks.ts`

- [ ] **Step 1: Rewrite `src/rpc-agent/hooks.ts`**

```ts
// RPC methods for managing Frida hooks installed against IL2CPP methods.
//
// Two flavors of API live here:
//
//   - Legacy one-shot RPCs (`hook`, `replaceNoop`, `forceReturn`,
//     `patchStatic`, `callStatic`, `callStaticOverload`) used by the
//     standalone tools and ad-hoc reverse-engineering. Kept as-is.
//
//   - Managed lifecycle RPCs (`installHook` / `revertHook` /
//     `listInstalledHooks` / `clearAllHooks`) consumed by the
//     Toolkit's Hooks plugin. Each managed hook has an opaque
//     `hookId` so the plugin can revert and re-install on edit.
//
// Managed hooks emit `HookEvent` payloads via Frida `send()` — the
// plugin subscribes via `coreApi.onAgentMessage`. Direct-mode only
// (HTTP RPC has no event channel back to the host).

import "frida-il2cpp-bridge";
import {
    findClass,
    findClassExact,
    hookLog,
    hookNoop,
    setStatic,
    forceReturn as libForceReturn,
    callStatic as libCallStatic,
    stringifyValue,
} from "../lib";
import { coerce } from "./registry";
import { notFoundClass, notFoundMethod } from "./errors";
import { getStackFrames } from "../lib/stack-trace";
import type { HookEvent, HookSpec, InstalledHook } from "./hook-types";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Legacy one-shot RPCs (preserved)
// ---------------------------------------------------------------------------

export function hook(className: string, methodName: string): Promise<void> {
    return inVm(() => hookLog(className, methodName));
}

export function replaceNoop(className: string, methodName: string): Promise<void> {
    return inVm(() => hookNoop(className, methodName));
}

export function patchStatic(className: string, field: string, value: any): Promise<void> {
    return inVm(() => setStatic(className, field, value));
}

export function forceReturn(className: string, method: string, value: any): Promise<void> {
    return inVm(() => libForceReturn(className, method, value));
}

export function callStatic(className: string, method: string, args: any[] = []): Promise<string> {
    return inVm(() => {
        const res = libCallStatic(className, method, ...args);
        return String(res);
    });
}

export function callStaticOverload(className: string, methodName: string, paramTypes: string[], args: any[] = []): Promise<string> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw notFoundClass(className);
        const method = klass.method(methodName).overload(...paramTypes);
        const coerced = args.map((v, i) => coerce(v, paramTypes[i]));
        const res = method.invoke(...coerced);
        return stringifyValue(res);
    });
}

// ---------------------------------------------------------------------------
// Managed hook lifecycle (used by the Hooks plugin)
// ---------------------------------------------------------------------------

interface ManagedEntry {
    spec: HookSpec;
    method: Il2Cpp.Method;
    installedAt: number;
    hitCount: number;
}

const _managed = new Map<string, ManagedEntry>();
let _hookIdCounter = 0;

function emit(payload: Omit<HookEvent, "type" | "ts">): void {
    const evt: HookEvent = { type: "hook-event", ts: Date.now(), ...payload };
    try { send(evt); } catch { /* host gone, drop */ }
}

function safeSelf(self: any): string | null {
    if (!self) return null;
    try {
        const cls = self.class?.name;
        const handle = self.handle;
        if (cls && handle) return `${cls}@${handle}`;
    } catch {}
    return null;
}

function safeArgs(args: any[]): string[] {
    return args.map((a) => {
        try { return stringifyValue(a); }
        catch (e) { return `<err: ${String(e).slice(0, 60)}>`; }
    });
}

function safeRetval(r: any): string | null {
    try { return stringifyValue(r); }
    catch (e) { return `<err: ${String(e).slice(0, 60)}>`; }
}

function installLogTemplate(hookId: string, entry: ManagedEntry, captureStack: boolean): void {
    const { method } = entry;
    const isStatic = method.isStatic;
    const klass = method.class;
    const methodName = entry.spec.methodName;

    method.implementation = function (this: any, ...args: any[]): any {
        const self = isStatic ? null : (this as Il2Cpp.Object);
        const argsStr = safeArgs(args);
        const selfStr = safeSelf(self);

        let stackFrames: string[] | undefined;
        if (captureStack) {
            const limit = entry.spec.stackCaptureCount ?? 5;
            if (entry.hitCount < limit && this.context) {
                try { stackFrames = getStackFrames(this.context, 20); } catch {}
            }
        }
        entry.hitCount++;

        let result: any;
        try {
            result = isStatic
                ? klass.method(methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        } catch (err) {
            emit({ hookId, self: selfStr, args: argsStr, retval: null, error: String(err), stackFrames });
            throw err;
        }
        emit({ hookId, self: selfStr, args: argsStr, retval: safeRetval(result), stackFrames });
        return result;
    };
}

function installNoopTemplate(hookId: string, entry: ManagedEntry): void {
    const { method } = entry;
    method.implementation = function (this: any, ..._args: any[]): any {
        entry.hitCount++;
        emit({ hookId, self: safeSelf(this), args: [], retval: null });
        return undefined;
    };
}

export function installHook(spec: HookSpec): { hookId: string } {
    return Il2Cpp.perform(() => {
        const klass = findClassExact(spec.className);
        if (!klass) throw notFoundClass(spec.className);
        const method = klass.tryMethod(spec.methodName);
        if (!method) throw notFoundMethod(spec.className, spec.methodName);

        const hookId = `h${++_hookIdCounter}`;
        const entry: ManagedEntry = { spec, method, installedAt: Date.now(), hitCount: 0 };

        switch (spec.template) {
            case "log":        installLogTemplate(hookId, entry, false); break;
            case "log-stack":  installLogTemplate(hookId, entry, true); break;
            case "noop":       installNoopTemplate(hookId, entry); break;
            case "force-return":
                throw new Error(`force-return not yet implemented (added in Task 12)`);
            default:
                throw new Error(`unknown template: ${(spec as { template: string }).template}`);
        }

        _managed.set(hookId, entry);
        return { hookId };
    }) as unknown as { hookId: string };
}

export function revertHook(hookId: string): { reverted: boolean } {
    return Il2Cpp.perform(() => {
        const entry = _managed.get(hookId);
        if (!entry) return { reverted: false };
        try { entry.method.revert(); } catch {}
        _managed.delete(hookId);
        return { reverted: true };
    }) as unknown as { reverted: boolean };
}

export function listInstalledHooks(): InstalledHook[] {
    const out: InstalledHook[] = [];
    _managed.forEach((entry, hookId) => {
        out.push({ hookId, spec: entry.spec, installedAt: entry.installedAt });
    });
    return out;
}

export function clearAllHooks(): { count: number } {
    return Il2Cpp.perform(() => {
        let count = 0;
        _managed.forEach((entry) => {
            try { entry.method.revert(); count++; } catch {}
        });
        _managed.clear();
        return { count };
    }) as unknown as { count: number };
}
```

- [ ] **Step 2: Build the agent**

Run: `npm run build:rpc`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/hooks.ts
git commit -m "$(cat <<'EOF'
feat(rpc-agent): managed hook lifecycle (installHook / revertHook / list)

Adds installHook/revertHook/listInstalledHooks/clearAllHooks for
the Hooks plugin. Templates 'log' and 'noop' implemented; events
streamed via Frida send({type:'hook-event', ...}). 'force-return'
and 'log-stack' wired to throw — added in Task 12 + reuse in the
'log' branch via the captureStack flag.

Legacy hook/replaceNoop/forceReturn/patchStatic/callStatic RPCs
preserved as-is for the standalone tools.
EOF
)"
```

---

## Task 4: Expose Frida `script.message` to CoreApi

**Files:**
- Modify: `dofus-app/vscode-extension/src/core/frida-direct.ts`
- Modify: `dofus-app/vscode-extension/src/core/api.ts`
- Modify: `dofus-app/vscode-extension/src/extension.ts`

- [ ] **Step 1: Inspect the current script.message handling in frida-direct**

Run: `grep -n "message" dofus-app/vscode-extension/src/core/frida-direct.ts | head`
Expected: at least one `script.message.connect(...)` line; remember the existing handler name.

- [ ] **Step 2: Add EventEmitter to FridaDirectClient**

In `dofus-app/vscode-extension/src/core/frida-direct.ts`, near the top of the class:

```ts
import * as vscode from "vscode";

export class FridaDirectClient implements RpcClient {
    // ... existing fields
    private readonly _onMessage = new vscode.EventEmitter<unknown>();
    /** Stream of `send()` payloads from the agent. */
    readonly onMessage = this._onMessage.event;
    // ...
}
```

In the existing `script.message` connect callback (search for `.connect(`), add:

```ts
script.message.connect((message: any, _data: any) => {
    if (message.type === "send" && message.payload !== undefined) {
        this._onMessage.fire(message.payload);
    }
    // ... keep existing behavior (logging etc.)
});
```

In the existing `dispose`/`detach` path:

```ts
this._onMessage.dispose();
```

- [ ] **Step 3: Add the field to CoreApi**

Edit `dofus-app/vscode-extension/src/core/api.ts`:

```ts
export interface CoreApi {
    // ... existing
    readonly onAgentMessage: vscode.Event<unknown>;
}

export interface CoreApiDeps {
    // ... existing
    onAgentMessage: vscode.Event<unknown>;
}

export function createCoreApi(deps: CoreApiDeps): CoreApi {
    // ... existing return object gains:
    return {
        // ...
        onAgentMessage: deps.onAgentMessage,
    };
}
```

- [ ] **Step 4: Plumb in extension.ts**

In `dofus-app/vscode-extension/src/extension.ts`, where `createCoreApi(...)` is called:

```ts
const onAgentMessage: vscode.Event<unknown> = fridaDirect
    ? fridaDirect.onMessage
    : new vscode.EventEmitter<unknown>().event; // no-op for HTTP mode

coreApi = createCoreApi({
    profileEmitter,
    profileDetachEmitter,
    profileSource,
    rpc,
    onAgentMessage,
});
```

- [ ] **Step 5: Compile the extension**

Run: `cd dofus-app/vscode-extension && npm run compile`
Expected: clean.

- [ ] **Step 6: Run existing tests (no regression)**

Run: `cd dofus-app/vscode-extension && npm test`
Expected: 65/65 pass.

- [ ] **Step 7: Commit**

```bash
git add dofus-app/vscode-extension/src/core/frida-direct.ts \
         dofus-app/vscode-extension/src/core/api.ts \
         dofus-app/vscode-extension/src/extension.ts
git commit -m "feat(toolkit): coreApi.onAgentMessage event for Frida send() stream"
```

---

## Task 5: Plugin types + spec validation (TDD)

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/types.ts`
- Create: `dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts`
- Create: `dofus-app/vscode-extension/test/plugins/hooks/hook-spec-validation.test.ts`

- [ ] **Step 1: Write the plugin types file**

```ts
// Plugin-side mirror of src/rpc-agent/hook-types.ts. Kept in sync manually —
// agent and extension live in different tsconfig roots.

export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;
    methodName: string;
    forceReturnValue?: unknown;
    stackCaptureCount?: number;
}

export interface InstalledHook {
    hookId: string;
    spec: HookSpec;
    installedAt: number;
}

export interface HookEvent {
    type: "hook-event";
    hookId: string;
    ts: number;
    self: string | null;
    args: string[];
    retval: string | null;
    error?: string;
    stackFrames?: string[];
}

/** Disk shape — what HookStore persists and what the tree provider consumes. */
export interface StoredHook {
    /** Stable on-disk UUID. Distinct from agent-assigned hookId. */
    id: string;
    spec: HookSpec;
    /** Set when installed agent-side. Volatile — reset on detach/reload. */
    installedHookId: string | null;
    addedAt: number;
}
```

- [ ] **Step 2: Write the failing validation test**

Create `dofus-app/vscode-extension/test/plugins/hooks/hook-spec-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { validateHookSpec } from "../../../src/plugins/hooks/hook-spec-validation";

const ok = (template: string, extra: Record<string, unknown> = {}) => ({
    template, className: "X", methodName: "y", ...extra,
});

describe("validateHookSpec", () => {
    it("accepts a minimal log spec", () => {
        const r = validateHookSpec(ok("log"));
        expect(r.ok).toBe(true);
    });

    it("accepts noop", () => {
        expect(validateHookSpec(ok("noop")).ok).toBe(true);
    });

    it("accepts log-stack with stackCaptureCount", () => {
        expect(validateHookSpec(ok("log-stack", { stackCaptureCount: 5 })).ok).toBe(true);
    });

    it("accepts log-stack without stackCaptureCount (defaulted agent-side)", () => {
        expect(validateHookSpec(ok("log-stack")).ok).toBe(true);
    });

    it("rejects force-return without forceReturnValue", () => {
        const r = validateHookSpec(ok("force-return"));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/forceReturnValue/);
    });

    it("accepts force-return with forceReturnValue (any type, even null)", () => {
        expect(validateHookSpec(ok("force-return", { forceReturnValue: 0 })).ok).toBe(true);
        expect(validateHookSpec(ok("force-return", { forceReturnValue: null })).ok).toBe(true);
        expect(validateHookSpec(ok("force-return", { forceReturnValue: "" })).ok).toBe(true);
    });

    it("rejects unknown template", () => {
        const r = validateHookSpec(ok("does-not-exist"));
        expect(r.ok).toBe(false);
    });

    it("rejects empty className or methodName", () => {
        expect(validateHookSpec({ template: "log", className: "", methodName: "y" }).ok).toBe(false);
        expect(validateHookSpec({ template: "log", className: "X", methodName: "" }).ok).toBe(false);
    });

    it("rejects negative stackCaptureCount", () => {
        const r = validateHookSpec(ok("log-stack", { stackCaptureCount: -1 }));
        expect(r.ok).toBe(false);
    });
});
```

- [ ] **Step 3: Run the failing test**

Run: `cd dofus-app/vscode-extension && npm test -- hook-spec-validation`
Expected: FAIL — module doesn't exist yet.

- [ ] **Step 4: Implement the validation**

Create `dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts`:

```ts
import type { HookSpec, HookTemplate } from "./types";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const TEMPLATES: ReadonlySet<HookTemplate> = new Set([
    "log", "noop", "force-return", "log-stack",
]);

export function validateHookSpec(input: unknown): ValidationResult {
    if (!input || typeof input !== "object") return { ok: false, reason: "spec is not an object" };
    const spec = input as Partial<HookSpec>;
    if (typeof spec.template !== "string" || !TEMPLATES.has(spec.template as HookTemplate)) {
        return { ok: false, reason: `unknown template: ${String(spec.template)}` };
    }
    if (typeof spec.className !== "string" || spec.className.length === 0) {
        return { ok: false, reason: "className must be a non-empty string" };
    }
    if (typeof spec.methodName !== "string" || spec.methodName.length === 0) {
        return { ok: false, reason: "methodName must be a non-empty string" };
    }
    if (spec.template === "force-return") {
        if (!("forceReturnValue" in spec)) {
            return { ok: false, reason: "force-return requires forceReturnValue" };
        }
    }
    if (spec.stackCaptureCount !== undefined) {
        if (typeof spec.stackCaptureCount !== "number" || spec.stackCaptureCount < 0) {
            return { ok: false, reason: "stackCaptureCount must be >= 0" };
        }
    }
    return { ok: true };
}
```

- [ ] **Step 5: Run the test — should pass**

Run: `cd dofus-app/vscode-extension && npm test -- hook-spec-validation`
Expected: 9/9 pass.

- [ ] **Step 6: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/types.ts \
         dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts \
         dofus-app/vscode-extension/test/plugins/hooks/hook-spec-validation.test.ts
git commit -m "feat(plugin-hooks): types + validateHookSpec (TDD)"
```

---

## Task 6: HookStore — CRUD + persistence (TDD)

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts`
- Create: `dofus-app/vscode-extension/test/plugins/hooks/hook-store.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { DiskPluginStorage } from "../../../src/core/plugin-storage";
import { HookStore } from "../../../src/plugins/hooks/hook-store";
import type { HookSpec } from "../../../src/plugins/hooks/types";

interface FakeRpc { calls: Array<{ method: string; args: unknown[] }>; nextHookId: number; }

function makeFakeRpc(): { rpc: { call<T>(m: string, a?: unknown[]): Promise<T> }; state: FakeRpc } {
    const state: FakeRpc = { calls: [], nextHookId: 1 };
    return {
        state,
        rpc: {
            call: async <T,>(method: string, args: unknown[] = []): Promise<T> => {
                state.calls.push({ method, args });
                if (method === "installHook") {
                    return { hookId: `h${state.nextHookId++}` } as unknown as T;
                }
                if (method === "revertHook") {
                    return { reverted: true } as unknown as T;
                }
                return undefined as unknown as T;
            },
        },
    };
}

const SPEC: HookSpec = { template: "log", className: "ecu", methodName: "xbe" };

let tmpRoot: string;
let storage: DiskPluginStorage;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hook-store-"));
    storage = new DiskPluginStorage(tmpRoot, "hooks");
});

describe("HookStore", () => {
    it("starts empty", () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        expect(store.list()).toEqual([]);
    });

    it("add() persists and returns a StoredHook with id", () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(stored.installedHookId).toBeNull();
        expect(stored.spec).toEqual(SPEC);

        // reload from disk → still there
        const store2 = new HookStore(storage, rpc);
        expect(store2.list()).toHaveLength(1);
        expect(store2.list()[0].spec).toEqual(SPEC);
        expect(store2.list()[0].installedHookId).toBeNull();  // disarmed at reload
    });

    it("install() calls RPC and stores the agent-assigned hookId", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);

        await store.install(stored.id);

        expect(state.calls[0]).toEqual({ method: "installHook", args: [SPEC] });
        const after = store.list()[0];
        expect(after.installedHookId).toBe("h1");
    });

    it("uninstall() reverts agent-side and clears installedHookId", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await store.uninstall(stored.id);

        expect(state.calls[1]).toEqual({ method: "revertHook", args: ["h1"] });
        expect(store.list()[0].installedHookId).toBeNull();
    });

    it("update() replaces the spec; if installed, re-installs with new spec", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        const newSpec: HookSpec = { template: "noop", className: "ecu", methodName: "xbe" };

        await store.update(stored.id, newSpec);

        // sequence: install(spec) → revert(h1) → install(newSpec) returns h2
        expect(state.calls.map(c => c.method)).toEqual(["installHook", "revertHook", "installHook"]);
        expect(store.list()[0].spec).toEqual(newSpec);
        expect(store.list()[0].installedHookId).toBe("h2");
    });

    it("update() while disarmed only swaps the spec — no RPC", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        const newSpec: HookSpec = { template: "noop", className: "ecu", methodName: "xbe" };

        await store.update(stored.id, newSpec);
        expect(state.calls).toHaveLength(0);
        expect(store.list()[0].spec).toEqual(newSpec);
    });

    it("remove() reverts if installed and persists removal", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const stored = store.add(SPEC);
        await store.install(stored.id);

        await store.remove(stored.id);

        expect(state.calls.map(c => c.method)).toEqual(["installHook", "revertHook"]);
        expect(store.list()).toEqual([]);
        const reloaded = new HookStore(storage, rpc);
        expect(reloaded.list()).toEqual([]);
    });

    it("uninstallAll() reverts every installed hook", async () => {
        const { rpc, state } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        const a = store.add({ ...SPEC, methodName: "ma" });
        const b = store.add({ ...SPEC, methodName: "mb" });
        await store.install(a.id);
        await store.install(b.id);

        await store.uninstallAll();

        expect(state.calls.filter(c => c.method === "revertHook")).toHaveLength(2);
        expect(store.list().every(h => h.installedHookId === null)).toBe(true);
    });

    it("emits onChange after add / install / update / uninstall / remove", async () => {
        const { rpc } = makeFakeRpc();
        const store = new HookStore(storage, rpc);
        let count = 0;
        store.onChange(() => count++);
        const stored = store.add(SPEC);
        await store.install(stored.id);
        await store.update(stored.id, { ...SPEC, template: "noop" });
        await store.uninstall(stored.id);
        await store.remove(stored.id);
        expect(count).toBe(5);
    });
});
```

- [ ] **Step 2: Run tests — they should fail to import**

Run: `cd dofus-app/vscode-extension && npm test -- hook-store`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement HookStore**

Create `dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts`:

```ts
import * as crypto from "crypto";

import type { PluginStorage } from "../../core/api";
import type { HookSpec, StoredHook } from "./types";

interface RpcLike {
    call<T>(method: string, args?: unknown[]): Promise<T>;
}

interface DiskShape {
    hooks: Array<Omit<StoredHook, "installedHookId">>;
}

const STORAGE_KEY = "hooks";

type Listener = () => void;

export class HookStore {
    private hooks: StoredHook[] = [];
    private listeners: Listener[] = [];

    constructor(
        private readonly storage: PluginStorage,
        private readonly rpc: RpcLike,
    ) {
        this.reload();
    }

    /** Refresh from disk. All hooks come back disarmed. */
    reload(): void {
        const raw = this.storage.get<DiskShape>(STORAGE_KEY);
        const arr = raw?.hooks ?? [];
        this.hooks = arr.map((h) => ({
            id: h.id,
            spec: h.spec,
            installedHookId: null,
            addedAt: h.addedAt,
        }));
        this.emit();
    }

    list(): StoredHook[] {
        // Return a shallow copy to prevent external mutation.
        return this.hooks.map((h) => ({ ...h }));
    }

    add(spec: HookSpec): StoredHook {
        const stored: StoredHook = {
            id: crypto.randomUUID(),
            spec,
            installedHookId: null,
            addedAt: Date.now(),
        };
        this.hooks.push(stored);
        this.persist();
        this.emit();
        return { ...stored };
    }

    async update(id: string, spec: HookSpec): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) throw new Error(`hook ${id} not found`);
        const wasInstalled = h.installedHookId !== null;
        if (wasInstalled) {
            await this.rpc.call("revertHook", [h.installedHookId]);
            h.installedHookId = null;
        }
        h.spec = spec;
        if (wasInstalled) {
            const r = await this.rpc.call<{ hookId: string }>("installHook", [spec]);
            h.installedHookId = r.hookId;
        }
        this.persist();
        this.emit();
    }

    async remove(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) return;
        if (h.installedHookId !== null) {
            await this.rpc.call("revertHook", [h.installedHookId]);
        }
        this.hooks = this.hooks.filter((x) => x.id !== id);
        this.persist();
        this.emit();
    }

    async install(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) throw new Error(`hook ${id} not found`);
        if (h.installedHookId !== null) return;
        const r = await this.rpc.call<{ hookId: string }>("installHook", [h.spec]);
        h.installedHookId = r.hookId;
        this.emit();
    }

    async uninstall(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) return;
        if (h.installedHookId === null) return;
        await this.rpc.call("revertHook", [h.installedHookId]);
        h.installedHookId = null;
        this.emit();
    }

    async uninstallAll(): Promise<void> {
        for (const h of this.hooks) {
            if (h.installedHookId !== null) {
                try { await this.rpc.call("revertHook", [h.installedHookId]); }
                catch { /* keep going */ }
                h.installedHookId = null;
            }
        }
        this.emit();
    }

    /** Reset every installedHookId without an RPC call — for use on detach. */
    markAllDisarmed(): void {
        for (const h of this.hooks) h.installedHookId = null;
        this.emit();
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }

    private persist(): void {
        const data: DiskShape = {
            hooks: this.hooks.map((h) => ({
                id: h.id, spec: h.spec, addedAt: h.addedAt,
            })),
        };
        this.storage.set(STORAGE_KEY, data);
    }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd dofus-app/vscode-extension && npm test -- hook-store`
Expected: 9/9 pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts \
         dofus-app/vscode-extension/test/plugins/hooks/hook-store.test.ts
git commit -m "feat(plugin-hooks): HookStore with CRUD + per-profile persistence (TDD)"
```

---

## Task 7: HookEventBus (TDD)

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts`
- Create: `dofus-app/vscode-extension/test/plugins/hooks/hook-event-bus.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";

import { HookEventBus } from "../../../src/plugins/hooks/hook-event-bus";
import type { HookEvent } from "../../../src/plugins/hooks/types";

interface FakeEmitter {
    fire(payload: unknown): void;
    event: (listener: (p: unknown) => void) => { dispose(): void };
}

function makeFakeEmitter(): FakeEmitter {
    const listeners: Array<(p: unknown) => void> = [];
    return {
        fire: (p) => { for (const l of listeners) l(p); },
        event: (l) => {
            listeners.push(l);
            return { dispose: () => { const i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); } };
        },
    };
}

const evt = (hookId: string): HookEvent => ({
    type: "hook-event", hookId, ts: 1, self: null, args: [], retval: null,
});

describe("HookEventBus", () => {
    it("forwards hook-event payloads to subscribers", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const seen: HookEvent[] = [];
        bus.onHookEvent((e) => seen.push(e));

        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));

        expect(seen.map((e) => e.hookId)).toEqual(["h1", "h2"]);
    });

    it("ignores non-hook-event payloads", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const seen: HookEvent[] = [];
        bus.onHookEvent((e) => seen.push(e));

        emitter.fire({ type: "other", foo: 1 });
        emitter.fire(null);
        emitter.fire("string");
        emitter.fire(evt("h1"));

        expect(seen).toHaveLength(1);
    });

    it("supports multiple listeners independently", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 100);
        const a: HookEvent[] = [];
        const b: HookEvent[] = [];
        bus.onHookEvent((e) => a.push(e));
        bus.onHookEvent((e) => b.push(e));

        emitter.fire(evt("h1"));

        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
    });

    it("ring buffer keeps last N events for late subscribers", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 3);

        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));
        emitter.fire(evt("h3"));
        emitter.fire(evt("h4"));

        expect(bus.snapshot().map((e) => e.hookId)).toEqual(["h2", "h3", "h4"]);
    });

    it("clear() empties the ring buffer", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 10);
        emitter.fire(evt("h1"));
        emitter.fire(evt("h2"));
        bus.clear();
        expect(bus.snapshot()).toEqual([]);
    });

    it("listener errors do not break the bus", () => {
        const emitter = makeFakeEmitter();
        const bus = new HookEventBus(emitter.event, 10);
        bus.onHookEvent(() => { throw new Error("boom"); });
        const ok: HookEvent[] = [];
        bus.onHookEvent((e) => ok.push(e));

        emitter.fire(evt("h1"));
        expect(ok).toHaveLength(1);
    });
});
```

- [ ] **Step 2: Run tests — should fail**

Run: `cd dofus-app/vscode-extension && npm test -- hook-event-bus`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement HookEventBus**

Create `dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts`:

```ts
import type { HookEvent } from "./types";

type Disposable = { dispose(): void };
type AgentEvent<T> = (listener: (payload: T) => void) => Disposable;
type HookEventListener = (event: HookEvent) => void;

function isHookEvent(p: unknown): p is HookEvent {
    return !!p && typeof p === "object" && (p as { type?: string }).type === "hook-event";
}

export class HookEventBus {
    private readonly listeners: HookEventListener[] = [];
    private readonly ring: HookEvent[] = [];
    private readonly subscription: Disposable;

    constructor(
        agentEvent: AgentEvent<unknown>,
        private readonly ringSize: number = 10_000,
    ) {
        this.subscription = agentEvent((p) => {
            if (!isHookEvent(p)) return;
            this.ring.push(p);
            if (this.ring.length > this.ringSize) {
                this.ring.splice(0, this.ring.length - this.ringSize);
            }
            for (const l of this.listeners) {
                try { l(p); } catch { /* swallow */ }
            }
        });
    }

    onHookEvent(listener: HookEventListener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Snapshot of buffered events (oldest first). Defensive copy. */
    snapshot(): HookEvent[] {
        return this.ring.slice();
    }

    clear(): void {
        this.ring.length = 0;
    }

    dispose(): void {
        this.subscription.dispose();
        this.listeners.length = 0;
        this.ring.length = 0;
    }
}
```

- [ ] **Step 4: Run tests — should pass**

Run: `cd dofus-app/vscode-extension && npm test -- hook-event-bus`
Expected: 6/6 pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts \
         dofus-app/vscode-extension/test/plugins/hooks/hook-event-bus.test.ts
git commit -m "feat(plugin-hooks): HookEventBus with ring buffer + multi-listener (TDD)"
```

---

## Task 8: HooksTreeProvider + package.json view

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/hooks-tree.ts`
- Modify: `dofus-app/vscode-extension/package.json`

- [ ] **Step 1: Implement the tree provider**

```ts
import * as vscode from "vscode";

import type { LabelStore } from "../../core/labels";
import type { StoredHook } from "./types";
import type { HookStore } from "./hook-store";

export class HooksTreeProvider implements vscode.TreeDataProvider<StoredHook> {
    private readonly _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;

    constructor(
        private readonly store: HookStore,
        private readonly labels: () => LabelStore | null,
    ) {
        store.onChange(() => this._changed.fire());
    }

    refresh(): void { this._changed.fire(); }

    getTreeItem(h: StoredHook): vscode.TreeItem {
        const friendlyClass = this.friendlyClassName(h.spec.className);
        const friendlyMethod = this.friendlyMethodName(h.spec.className, h.spec.methodName);
        const label = `${friendlyClass}.${friendlyMethod}`;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        const installed = h.installedHookId !== null;
        item.iconPath = new vscode.ThemeIcon(installed ? "circle-filled" : "circle-outline");
        item.description = `[${h.spec.template}]${installed ? " ●" : ""}`;
        item.tooltip = [
            `${h.spec.className}.${h.spec.methodName}`,
            `template: ${h.spec.template}`,
            installed ? `installed: ${h.installedHookId}` : "disarmed",
        ].join("\n");
        item.contextValue = installed ? "frida.hook.installed" : "frida.hook.disarmed";
        item.command = {
            command: "frida.hooks.openLog",
            title: "Open hook log",
            arguments: [h.id],
        };
        return item;
    }

    getChildren(node?: StoredHook): StoredHook[] {
        if (node) return [];
        return this.store.list();
    }

    private friendlyClassName(obf: string): string {
        const labels = this.labels();
        return labels?.get({ kind: "class", className: obf }) ?? obf;
    }

    private friendlyMethodName(cls: string, methodObf: string): string {
        const labels = this.labels();
        return labels?.get({ kind: "method", className: cls, methodName: methodObf }) ?? methodObf;
    }
}
```

- [ ] **Step 2: Add view + commands to package.json**

In `dofus-app/vscode-extension/package.json`, under `"contributes"`:

In `views.fridaToolkit`, append:
```json
{ "id": "fridaHooks", "name": "Hooks" }
```

In `commands` array, append:
```json
{ "command": "frida.hooks.add",            "title": "Frida: Hooks — Add..." },
{ "command": "frida.hooks.toggle",         "title": "Frida: Hooks — Install / Uninstall" },
{ "command": "frida.hooks.delete",         "title": "Frida: Hooks — Delete" },
{ "command": "frida.hooks.edit",           "title": "Frida: Hooks — Edit..." },
{ "command": "frida.hooks.openLog",        "title": "Frida: Hooks — Open Log" },
{ "command": "frida.hooks.clearAll",       "title": "Frida: Hooks — Uninstall all" }
```

Add a `view/item/context` menu group under `menus`:
```json
"view/item/context": [
    { "command": "frida.hooks.toggle", "when": "view == fridaHooks && viewItem =~ /^frida\\.hook\\./", "group": "inline@1" },
    { "command": "frida.hooks.edit",   "when": "view == fridaHooks && viewItem =~ /^frida\\.hook\\./", "group": "1_modify" },
    { "command": "frida.hooks.delete", "when": "view == fridaHooks && viewItem =~ /^frida\\.hook\\./", "group": "9_destroy" }
]
```

- [ ] **Step 3: Compile**

Run: `cd dofus-app/vscode-extension && npm run compile`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/hooks-tree.ts \
         dofus-app/vscode-extension/package.json
git commit -m "feat(plugin-hooks): HooksTreeProvider + view/command contributions"
```

---

## Task 9: Plugin commands (add / toggle / delete) + plugin entry

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/commands.ts`
- Create: `dofus-app/vscode-extension/src/plugins/hooks/index.ts`
- Modify: `dofus-app/vscode-extension/src/extension.ts`

- [ ] **Step 1: Implement commands**

```ts
// dofus-app/vscode-extension/src/plugins/hooks/commands.ts
import * as vscode from "vscode";

import type { CoreApi } from "../../core/api";
import { validateHookSpec } from "./hook-spec-validation";
import type { HookStore } from "./hook-store";
import type { HookTemplate, HookSpec, StoredHook } from "./types";

export interface HooksCommandDeps {
    store: HookStore;
    coreApi: CoreApi;
    /** Lazy — created on first frida.hooks.openLog call. */
    openLog: (focusHookId?: string) => void;
}

const TEMPLATES: HookTemplate[] = ["log", "log-stack", "noop", "force-return"];

async function pickSpec(initial?: HookSpec): Promise<HookSpec | undefined> {
    const className = await vscode.window.showInputBox({
        prompt: "Class obf name (e.g. ecu, MapRenderer)",
        value: initial?.className ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!className) return undefined;

    const methodName = await vscode.window.showInputBox({
        prompt: `Method name on ${className}`,
        value: initial?.methodName ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!methodName) return undefined;

    const template = await vscode.window.showQuickPick(TEMPLATES, {
        placeHolder: "Hook template",
    });
    if (!template) return undefined;

    let forceReturnValue: unknown;
    if (template === "force-return") {
        const raw = await vscode.window.showInputBox({
            prompt: "Force-return value (literal — number, true/false, null, or quoted string)",
            value: typeof initial?.forceReturnValue === "string" ? initial.forceReturnValue : "",
        });
        if (raw === undefined) return undefined;
        try { forceReturnValue = JSON.parse(raw); }
        catch { forceReturnValue = raw; /* treat as raw string */ }
    }

    let stackCaptureCount: number | undefined;
    if (template === "log-stack") {
        const raw = await vscode.window.showInputBox({
            prompt: "Stack capture count (first N hits, default 5)",
            value: String(initial?.stackCaptureCount ?? 5),
            validateInput: (v) => /^\d+$/.test(v) ? null : "must be a non-negative integer",
        });
        if (raw === undefined) return undefined;
        stackCaptureCount = parseInt(raw, 10);
    }

    return { template, className, methodName, forceReturnValue, stackCaptureCount };
}

export function registerHookCommands(deps: HooksCommandDeps): vscode.Disposable[] {
    const { store, coreApi, openLog } = deps;
    const cmds: vscode.Disposable[] = [];

    cmds.push(vscode.commands.registerCommand("frida.hooks.add", async () => {
        const spec = await pickSpec();
        if (!spec) return;
        const v = validateHookSpec(spec);
        if (!v.ok) { vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`); return; }
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Hook installed: ${spec.className}.${spec.methodName}`);
        } catch (err) {
            vscode.window.showWarningMessage(
                `Hook saved but install failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.toggle", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        try {
            if (target.installedHookId === null) await store.install(target.id);
            else await store.uninstall(target.id);
        } catch (err) {
            vscode.window.showErrorMessage(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.delete", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        const yes = await vscode.window.showWarningMessage(
            `Delete hook ${target.spec.className}.${target.spec.methodName}?`,
            { modal: true }, "Delete",
        );
        if (yes !== "Delete") return;
        await store.remove(target.id);
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.edit", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        const spec = await pickSpec(target.spec);
        if (!spec) return;
        const v = validateHookSpec(spec);
        if (!v.ok) { vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`); return; }
        try {
            await store.update(target.id, spec);
        } catch (err) {
            vscode.window.showErrorMessage(`Edit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.openLog", (hookIdFocus?: string) => {
        openLog(hookIdFocus);
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.clearAll", async () => {
        const yes = await vscode.window.showWarningMessage(
            "Uninstall every active hook? Definitions stay on disk.",
            { modal: true }, "Uninstall all",
        );
        if (yes !== "Uninstall all") return;
        try {
            const r = await coreApi.rpc.call<{ count: number }>("clearAllHooks");
            store.markAllDisarmed();
            vscode.window.showInformationMessage(`Uninstalled ${r.count} hooks`);
        } catch (err) {
            vscode.window.showErrorMessage(`clearAll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    return cmds;
}

async function resolveTarget(store: HookStore, fromArg: StoredHook | undefined): Promise<StoredHook | undefined> {
    if (fromArg && typeof fromArg === "object" && "id" in fromArg) return fromArg;
    const list = store.list();
    if (list.length === 0) {
        vscode.window.showInformationMessage("No hooks defined yet.");
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        list.map((h) => ({
            label: `${h.spec.className}.${h.spec.methodName}`,
            description: `[${h.spec.template}]${h.installedHookId ? " installed" : " disarmed"}`,
            hook: h,
        })),
        { placeHolder: "Pick a hook" },
    );
    return pick?.hook;
}
```

- [ ] **Step 2: Implement plugin entry**

```ts
// dofus-app/vscode-extension/src/plugins/hooks/index.ts
import * as vscode from "vscode";

import type { CoreApi } from "../../core/api";
import { HookStore } from "./hook-store";
import { HookEventBus } from "./hook-event-bus";
import { HooksTreeProvider } from "./hooks-tree";
import { registerHookCommands } from "./commands";

export function activateHooksPlugin(coreApi: CoreApi, _ctx: vscode.ExtensionContext): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    const eventBus = new HookEventBus(coreApi.onAgentMessage, 10_000);
    disposables.push({ dispose: () => eventBus.dispose() });

    // Lazy lookup — store creation depends on a current profile.
    let store: HookStore | null = null;
    const ensureStore = (): HookStore => {
        if (store) return store;
        const storage = coreApi.storage("hooks");
        store = new HookStore(storage, coreApi.rpc);
        return store;
    };
    const labelsAccessor = (): import("../../core/labels").LabelStore | null => {
        try { return coreApi.labels; } catch { return null; }
    };

    // Build pieces lazily after the first attach so storage() doesn't throw.
    let bound = false;
    const bind = (): void => {
        if (bound) return;
        bound = true;
        const s = ensureStore();
        const tree = new HooksTreeProvider(s, labelsAccessor);
        disposables.push(coreApi.ui.addView("fridaHooks", tree));

        // Reset installedHookId state on detach (no agent reverts —
        // agent already gone). Reload defs on next attach.
        disposables.push(coreApi.profile.onDetach.event(() => s.markAllDisarmed()));
        disposables.push(coreApi.profile.onAttach.event(() => s.reload()));

        const openLog = (_focusHookId?: string): void => {
            // Implemented in Task 10 — placeholder for now.
            coreApi.ui.notify("Hook Log webview coming in Task 10", "info");
        };

        disposables.push(...registerHookCommands({ store: s, coreApi, openLog }));
    };

    if (coreApi.profile.current()) bind();
    else disposables.push(coreApi.profile.onAttach.event(() => bind()));

    return vscode.Disposable.from(...disposables);
}
```

- [ ] **Step 3: Wire activation in extension.ts**

In `dofus-app/vscode-extension/src/extension.ts`, after `coreApi = createCoreApi(...)`:

```ts
import { activateHooksPlugin } from "./plugins/hooks";

// ... in activate():
context.subscriptions.push(activateHooksPlugin(coreApi, context));
```

- [ ] **Step 4: Compile + run tests**

Run: `cd dofus-app/vscode-extension && npm run compile && npm test`
Expected: clean compile, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/commands.ts \
         dofus-app/vscode-extension/src/plugins/hooks/index.ts \
         dofus-app/vscode-extension/src/extension.ts
git commit -m "feat(plugin-hooks): commands + plugin entry, wired in extension.activate"
```

---

## Task 10: HookLogPanel — Stream tab only

**Files:**
- Create: `dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts`
- Modify: `dofus-app/vscode-extension/src/plugins/hooks/index.ts` (replace placeholder openLog)

- [ ] **Step 1: Implement HookLogPanel**

```ts
// dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts
import * as vscode from "vscode";

import type { HookEventBus } from "../hook-event-bus";
import type { HookStore } from "../hook-store";
import type { HookEvent, StoredHook } from "../types";

export class HookLogPanel {
    private panel: vscode.WebviewPanel | null = null;
    private busSub: (() => void) | null = null;
    private storeSub: (() => void) | null = null;
    private paused = false;

    constructor(
        private readonly bus: HookEventBus,
        private readonly store: HookStore,
    ) {}

    show(focusHookId?: string): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                "fridaHookLog",
                "Hook Log",
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.webview.html = this.html();
            this.panel.onDidDispose(() => this.teardown());
            this.panel.webview.onDidReceiveMessage((m: { type: string; value?: unknown }) => {
                if (m.type === "pause") this.paused = true;
                if (m.type === "resume") this.paused = false;
                if (m.type === "clear") this.bus.clear();
            });

            // Replay ring buffer on first open.
            this.panel.webview.postMessage({ type: "init", events: this.bus.snapshot(), hooks: this.store.list() });

            this.busSub = this.bus.onHookEvent((e) => {
                if (this.paused) return;
                this.panel?.webview.postMessage({ type: "event", event: e });
            });
            this.storeSub = this.store.onChange(() => {
                this.panel?.webview.postMessage({ type: "hooks", hooks: this.store.list() });
            });
        }
        this.panel.reveal();
        if (focusHookId) {
            this.panel.webview.postMessage({ type: "focus", hookId: focusHookId });
        }
    }

    private teardown(): void {
        this.busSub?.();
        this.storeSub?.();
        this.busSub = null;
        this.storeSub = null;
        this.panel = null;
    }

    dispose(): void {
        this.panel?.dispose();
        this.teardown();
    }

    private html(): string {
        return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            body { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background); margin: 0; padding: 0; }
            .toolbar { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
                display: flex; gap: 8px; align-items: center; position: sticky; top: 0;
                background: var(--vscode-editor-background); }
            button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            #filter { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border); padding: 3px 6px; flex: 1; min-width: 100px; }
            #stream { padding: 0 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
            .row { padding: 2px 0; border-bottom: 1px dotted var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; }
            .row.expanded .details { display: block; }
            .details { display: none; padding: 4px 0 4px 16px; color: var(--vscode-descriptionForeground); }
            .ts { color: var(--vscode-descriptionForeground); margin-right: 6px; }
            .cls { color: var(--vscode-symbolIcon-classForeground, var(--vscode-textLink-foreground)); }
            .args { color: var(--vscode-textPreformat-foreground); }
            .ret { color: var(--vscode-charts-green); }
            .err { color: var(--vscode-errorForeground); }
        </style></head><body>
            <div class="toolbar">
                <button id="pause">Pause</button>
                <button id="clear">Clear</button>
                <input id="filter" placeholder="Filter — text in args/retval/class/method" />
                <span id="count" style="opacity:.7"></span>
            </div>
            <div id="stream"></div>
            <script>
                const vscode = acquireVsCodeApi();
                let paused = false;
                let filterText = "";
                let hookSpecs = new Map(); // hookId(installed) -> { className, methodName, template }
                const stream = document.getElementById("stream");
                const countEl = document.getElementById("count");
                const filterInput = document.getElementById("filter");
                const pauseBtn = document.getElementById("pause");
                const clearBtn = document.getElementById("clear");

                let totalSeen = 0;
                let shown = 0;
                const HARD_LIMIT = 5000;

                function rebuildHookSpecs(hooks) {
                    hookSpecs = new Map();
                    for (const h of hooks) {
                        if (h.installedHookId) hookSpecs.set(h.installedHookId, h.spec);
                    }
                }

                function fmtRow(e) {
                    const spec = hookSpecs.get(e.hookId);
                    const cls = spec ? spec.className : e.hookId;
                    const m = spec ? spec.methodName : "?";
                    const args = e.args.join(", ");
                    const ret = e.error ? "<span class=err>throw " + escape(e.error) + "</span>"
                        : "<span class=ret>" + escape(e.retval ?? "void") + "</span>";
                    const ts = new Date(e.ts).toISOString().slice(11, 23);
                    const stackHtml = (e.stackFrames && e.stackFrames.length)
                        ? "<div class=details>stack:<br>" + e.stackFrames.map(escape).join("<br>") + "</div>"
                        : "";
                    return "<div class=row><span class=ts>" + ts + "</span>" +
                        "<span class=cls>" + escape(cls + "." + m) + "</span> " +
                        "<span class=args>(" + escape(args) + ")</span> → " + ret +
                        stackHtml + "</div>";
                }

                function escape(s) {
                    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                }

                function matches(e) {
                    if (!filterText) return true;
                    const haystack = [
                        hookSpecs.get(e.hookId)?.className ?? "",
                        hookSpecs.get(e.hookId)?.methodName ?? "",
                        ...(e.args ?? []),
                        e.retval ?? "",
                        e.error ?? "",
                    ].join(" ").toLowerCase();
                    return haystack.indexOf(filterText) >= 0;
                }

                function append(e) {
                    totalSeen++;
                    if (!matches(e)) { updateCount(); return; }
                    stream.insertAdjacentHTML("beforeend", fmtRow(e));
                    shown++;
                    while (stream.children.length > HARD_LIMIT) {
                        stream.removeChild(stream.firstChild);
                    }
                    if (!paused) stream.scrollIntoView({ block: "end" });
                    updateCount();
                }

                function updateCount() {
                    countEl.textContent = shown + " shown / " + totalSeen + " total";
                }

                function rerenderAll(events) {
                    stream.innerHTML = "";
                    shown = 0;
                    totalSeen = events.length;
                    for (const e of events) {
                        if (matches(e)) {
                            stream.insertAdjacentHTML("beforeend", fmtRow(e));
                            shown++;
                        }
                    }
                    updateCount();
                }

                stream.addEventListener("click", (ev) => {
                    const row = ev.target.closest(".row");
                    if (row) row.classList.toggle("expanded");
                });

                filterInput.addEventListener("input", () => {
                    filterText = filterInput.value.toLowerCase();
                    rerenderAll(__lastSnapshot);
                });

                pauseBtn.addEventListener("click", () => {
                    paused = !paused;
                    pauseBtn.textContent = paused ? "Resume" : "Pause";
                    vscode.postMessage({ type: paused ? "pause" : "resume" });
                });

                clearBtn.addEventListener("click", () => {
                    stream.innerHTML = "";
                    totalSeen = 0; shown = 0;
                    updateCount();
                    vscode.postMessage({ type: "clear" });
                });

                let __lastSnapshot = [];
                window.addEventListener("message", (msg) => {
                    const m = msg.data;
                    if (m.type === "init") {
                        rebuildHookSpecs(m.hooks);
                        __lastSnapshot = m.events.slice();
                        rerenderAll(__lastSnapshot);
                    } else if (m.type === "hooks") {
                        rebuildHookSpecs(m.hooks);
                    } else if (m.type === "event") {
                        __lastSnapshot.push(m.event);
                        if (__lastSnapshot.length > 10000) __lastSnapshot.shift();
                        append(m.event);
                    }
                });
            </script>
        </body></html>`;
    }
}
```

- [ ] **Step 2: Replace placeholder in plugin entry**

In `dofus-app/vscode-extension/src/plugins/hooks/index.ts`, replace the placeholder block (`// Implemented in Task 10 — placeholder for now.`) with:

```ts
import { HookLogPanel } from "./webviews/hook-log";
// ... in bind(), replace the openLog stub:
const logPanel = new HookLogPanel(eventBus, s);
disposables.push({ dispose: () => logPanel.dispose() });
const openLog = (focusHookId?: string): void => logPanel.show(focusHookId);
```

- [ ] **Step 3: Compile + tests**

Run: `cd dofus-app/vscode-extension && npm run compile && npm test`
Expected: clean compile, 65/65 + new plugin tests still pass.

- [ ] **Step 4: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts \
         dofus-app/vscode-extension/src/plugins/hooks/index.ts
git commit -m "feat(plugin-hooks): HookLogPanel webview — Stream tab with filter/pause/clear"
```

---

## Task 11: force-return template (agent)

**Files:**
- Modify: `src/rpc-agent/hooks.ts`

- [ ] **Step 1: Implement the template**

In `src/rpc-agent/hooks.ts`, near the other `installXxxTemplate` helpers add:

```ts
function installForceReturnTemplate(hookId: string, entry: ManagedEntry): void {
    const { method, spec } = entry;
    const retTypeName = method.returnType.name;

    method.implementation = function (this: any, ..._args: any[]): any {
        entry.hitCount++;
        let coercedReturn: any;
        try {
            coercedReturn = coerce(spec.forceReturnValue, retTypeName);
        } catch {
            coercedReturn = spec.forceReturnValue;
        }
        emit({ hookId, self: safeSelf(this), args: [], retval: safeRetval(coercedReturn) });
        return coercedReturn;
    };
}
```

Then in the `switch` of `installHook`, replace the `force-return` throw with:

```ts
case "force-return":
    if (!("forceReturnValue" in spec)) {
        throw new Error("force-return requires spec.forceReturnValue");
    }
    installForceReturnTemplate(hookId, entry);
    break;
```

- [ ] **Step 2: Build the agent**

Run: `npm run build:rpc`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/rpc-agent/hooks.ts
git commit -m "feat(rpc-agent): hook template force-return"
```

---

## Task 12: log-stack template wiring is already in `installLogTemplate` — sanity test

**Files:** none (verification only)

- [ ] **Step 1: Re-read the `log-stack` branch**

Run: `grep -n "log-stack" src/rpc-agent/hooks.ts`
Expected: a single line in the `switch` calling `installLogTemplate(hookId, entry, true)`.

- [ ] **Step 2: Build the agent**

Run: `npm run build:rpc`
Expected: clean.

(No commit — wiring already done in Task 3. This task only confirms.)

---

## Task 13: Right-click integration in Process Explorer

**Files:**
- Modify: `dofus-app/vscode-extension/package.json`
- Modify: `dofus-app/vscode-extension/src/plugins/hooks/commands.ts`

- [ ] **Step 1: Add a contextual command**

In `commands.ts`, register one more handler that takes the obfuscated class/method name from a Process Explorer node:

```ts
cmds.push(vscode.commands.registerCommand("frida.hooks.addFromMember",
    async (className?: string, methodName?: string, isStatic?: boolean) => {
        if (!className || !methodName) {
            vscode.window.showWarningMessage("frida.hooks.addFromMember: missing className/methodName");
            return;
        }
        const template = await vscode.window.showQuickPick(["log", "log-stack", "noop"] as const, {
            placeHolder: `Hook ${className}.${methodName} as`,
        });
        if (!template) return;
        const spec = { template, className, methodName } as const;
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Hook installed: ${className}.${methodName}`);
        } catch (err) {
            vscode.window.showWarningMessage(
                `Hook saved disarmed (install failed): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    },
));
```

- [ ] **Step 2: Add command to package.json + a context menu entry**

Append to `commands`:
```json
{ "command": "frida.hooks.addFromMember", "title": "Frida: Hook this method..." }
```

Append to `view/item/context`:
```json
{ "command": "frida.hooks.addFromMember", "when": "view == fridaProcessExplorer && viewItem == frida.method", "group": "9_frida" }
```

- [ ] **Step 3: Wire the explorer item to pass obf name**

In `dofus-app/vscode-extension/src/core/explorer.ts`, in the `member` branch of `getTreeItem`, set `command.arguments`:

```ts
case "member": {
    // ... existing code that builds key + display + icon
    item.command = {
        command: "frida.hooks.addFromMember",
        title: "Hook…",
        arguments: [
            node.container.className,
            node.obfName,
            // isStatic flag isn't tracked in the node yet — pass undefined; agent infers.
        ],
    };
    return item;
}
```

(If `command` is already set on `member`, remove the `command` override and rely solely on the context menu so click ≠ hook. Refer to existing behavior — the spec calls for right-click, not click.)

- [ ] **Step 4: Compile**

Run: `cd dofus-app/vscode-extension && npm run compile`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add dofus-app/vscode-extension/package.json \
         dofus-app/vscode-extension/src/plugins/hooks/commands.ts \
         dofus-app/vscode-extension/src/core/explorer.ts
git commit -m "feat(plugin-hooks): right-click 'Hook this method...' in Process Explorer"
```

---

## Task 14: Summary tab + export

**Files:**
- Modify: `dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts`

- [ ] **Step 1: Add Summary tab**

Replace the `<body>` block of `html()` with the version below (adds tab toolbar, summary table, export):

```ts
// Replace ONLY the `<body>...</body>` portion of the existing template.
`            <div class="toolbar">
                <button id="tab-stream"  class="tab active">Stream</button>
                <button id="tab-summary" class="tab">Summary</button>
                <button id="pause">Pause</button>
                <button id="clear">Clear</button>
                <button id="export">Export JSON</button>
                <input id="filter" placeholder="Filter — text in args/retval/class/method" />
                <span id="count" style="opacity:.7"></span>
            </div>
            <div id="stream"></div>
            <table id="summary" style="display:none; width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th align="left">Hook</th>
                    <th align="right">Hits</th>
                    <th align="left">Last hit</th>
                    <th align="left">Last args</th>
                    <th align="left">Last retval / err</th>
                </tr></thead>
                <tbody></tbody>
            </table>
            <script>
                /* ... preserve everything from the previous version ... */
                /* ADD below: tab switching + summary aggregation */
                const tabStream = document.getElementById("tab-stream");
                const tabSummary = document.getElementById("tab-summary");
                const summaryEl = document.getElementById("summary");
                const exportBtn = document.getElementById("export");
                const summary = new Map(); // hookId -> { hits, lastTs, lastArgs, lastRet, lastErr, spec }

                function bumpSummary(e) {
                    let s = summary.get(e.hookId);
                    if (!s) {
                        s = { hits: 0, lastTs: 0, lastArgs: [], lastRet: null, lastErr: null,
                              spec: hookSpecs.get(e.hookId) ?? null };
                        summary.set(e.hookId, s);
                    }
                    s.hits++;
                    s.lastTs = e.ts;
                    s.lastArgs = e.args;
                    s.lastRet = e.retval;
                    s.lastErr = e.error ?? null;
                    s.spec = hookSpecs.get(e.hookId) ?? s.spec;
                }

                function renderSummary() {
                    const rows = [];
                    const sorted = [...summary.entries()].sort((a, b) => b[1].hits - a[1].hits);
                    for (const [hookId, s] of sorted) {
                        const name = s.spec ? (s.spec.className + "." + s.spec.methodName) : hookId;
                        const tail = s.lastErr
                            ? "<span class=err>throw " + escape(s.lastErr) + "</span>"
                            : "<span class=ret>" + escape(s.lastRet ?? "void") + "</span>";
                        rows.push(
                            "<tr><td>" + escape(name) + "</td>" +
                            "<td align=right>" + s.hits + "</td>" +
                            "<td>" + new Date(s.lastTs).toISOString().slice(11,23) + "</td>" +
                            "<td>(" + escape(s.lastArgs.join(", ")) + ")</td>" +
                            "<td>" + tail + "</td></tr>",
                        );
                    }
                    summaryEl.querySelector("tbody").innerHTML = rows.join("");
                }

                function showStream() {
                    tabStream.classList.add("active");
                    tabSummary.classList.remove("active");
                    stream.style.display = "";
                    summaryEl.style.display = "none";
                }
                function showSummary() {
                    tabStream.classList.remove("active");
                    tabSummary.classList.add("active");
                    stream.style.display = "none";
                    summaryEl.style.display = "";
                    renderSummary();
                }
                tabStream.addEventListener("click", showStream);
                tabSummary.addEventListener("click", showSummary);

                exportBtn.addEventListener("click", () => {
                    const blob = JSON.stringify(__lastSnapshot, null, 2);
                    vscode.postMessage({ type: "export", body: blob });
                });

                // bump summary inside the existing append() call:
                const _origAppend = append;
                append = function(e) { bumpSummary(e); _origAppend(e); };
                rerenderAll = (function (orig) {
                    return function(events) {
                        summary.clear();
                        for (const e of events) bumpSummary(e);
                        orig(events);
                        if (summaryEl.style.display !== "none") renderSummary();
                    };
                })(rerenderAll);
            </script>`
```

(Keep the `<style>` block; add `.tab.active { font-weight: bold; }` to it.)

- [ ] **Step 2: Handle `export` message host-side**

In `HookLogPanel.show()` `onDidReceiveMessage`:

```ts
if (m.type === "export") {
    void vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`hook-log-${Date.now()}.json`),
        filters: { JSON: ["json"] },
    }).then((uri) => {
        if (!uri) return;
        return vscode.workspace.fs.writeFile(uri, Buffer.from(String(m.value ?? m.body ?? ""), "utf-8"));
    });
}
```

(The webview posts `{ type: "export", body: blob }` — host writes it to disk.)

- [ ] **Step 3: Compile + smoke**

Run: `cd dofus-app/vscode-extension && npm run compile`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts
git commit -m "feat(plugin-hooks): HookLogPanel — Summary tab + JSON export"
```

---

## Task 15: SMOKE-TEST.md update + plugin README

**Files:**
- Modify: `dofus-app/vscode-extension/SMOKE-TEST.md`
- Create: `dofus-app/vscode-extension/src/plugins/hooks/README.md`

- [ ] **Step 1: Append a Hooks section to SMOKE-TEST.md**

Append at the end of the existing file:

```markdown

## Plugin Hooks (v1.1)

Pre-req : direct Frida mode (HTTP mode disables this plugin).

1. Attach to the target. The "Hooks" view appears in the Frida sidebar (empty).
2. Open Process Explorer → expand any class → right-click a method → "Frida: Hook this method..." → pick `log`. The hook appears in the Hooks tree with a filled circle (installed).
3. Open the Hook Log via Command Palette → "Frida: Hooks — Open Log". Trigger the method in-game; events scroll in the Stream tab. Switch to Summary — the hook shows a hit count.
4. Filter: type a substring of the class name in the filter input — only matching events stay.
5. Pause / Clear: pause halts new events from displaying (they keep being buffered in the bus); clear empties both stream + ring buffer.
6. Export JSON: click Export → save dialog → confirm a file is written with the buffered events.
7. Edit: right-click the hook in the tree → Edit → change template to `noop`. Verify hits in Stream now have empty args + null retval.
8. Toggle: click the inline toggle → tree icon goes hollow → no more events stream.
9. Detach (or restart the game) → re-attach → the Hooks tree shows the hook DISARMED (hollow circle). Click the toggle to install it again — events resume.
10. Switch builds: open a different Unity build of the game (or fake via gameNameOverride). The Hooks tree should be empty (per-profile isolation).
11. Clear all: command "Frida: Hooks — Uninstall all" → tree icons all go hollow.
12. Delete: right-click → Delete → confirm → the hook disappears from the tree and from disk (verify with `cat ~/.frida-toolkit/profiles/<game>/<build>/plugins/hooks/storage.json`).
```

- [ ] **Step 2: Write the plugin README**

```markdown
# Plugin: Hooks

First-party plugin shipped with the Toolkit Core. Adds Frida method hooks
managed via a tree sidebar, with a webview log panel for live observation.

## Architecture

Agent-side: `src/rpc-agent/hooks.ts` (managed lifecycle: installHook /
revertHook / listInstalledHooks / clearAllHooks). Each hit emits a
`HookEvent` via Frida `send()`.

Plugin-side: this folder. Persists hook definitions per-profile via
`coreApi.storage("hooks")` (the DiskPluginStorage from the Toolkit Core).
Hooks are saved DISARMED — re-arming on attach is explicit (no
auto-arm, see spec for rationale).

## Templates (v1.1)

| Template | What it does |
|----------|--------------|
| `log`         | Logs args + retval per call |
| `log-stack`   | Same as `log` plus an IL2CPP backtrace on the first N=5 hits |
| `noop`        | Replaces the method with a return-undefined stub |
| `force-return`| Replaces the method's return value with a constant |

## Modes

This plugin requires direct Frida mode (`fridaToolkit.useDirectMode = true`).
HTTP mode lacks the agent → host event channel.

## Files

- `index.ts` — `activateHooksPlugin(coreApi, ctx)`
- `hook-store.ts` — CRUD + persistence + RPC orchestration
- `hook-event-bus.ts` — `script.message` filter + ring buffer
- `hooks-tree.ts` — TreeDataProvider
- `commands.ts` — VSCode command handlers
- `webviews/hook-log.ts` — Stream + Summary webview
- `types.ts` — type mirror of `src/rpc-agent/hook-types.ts`
- `hook-spec-validation.ts` — pure validation

## Spec

`docs/superpowers/specs/2026-05-05-frida-il2cpp-toolkit-plugin-hooks-design.md`
```

- [ ] **Step 3: Run full test + build**

Run: `cd dofus-app/vscode-extension && npm test && npm run compile`
Then: `cd ../.. && npm run build:rpc`

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add dofus-app/vscode-extension/SMOKE-TEST.md \
         dofus-app/vscode-extension/src/plugins/hooks/README.md
git commit -m "docs(plugin-hooks): smoke test sequence + plugin README"
```

---

## Self-Review

After completing all tasks, verify against the spec:

- ✅ Tree sidebar "Hooks" with toggle/edit/delete (Tasks 8, 9)
- ✅ Webview Hook Log with Stream + Summary tabs (Tasks 10, 14)
- ✅ 4 P0 templates: log, log-stack, noop, force-return (Tasks 3, 11, 12)
- ✅ Per-profile persistence via DiskPluginStorage, disarmed at attach (Task 6 + plugin entry)
- ✅ Agent-side execution, async send() events (Task 3, 4)
- ✅ Stack trace on first N=5 hits (Tasks 1, 3, 12)
- ✅ Right-click integration in Process Explorer (Task 13)
- ✅ Filter input + Pause + Clear + Export (Tasks 10, 14)
- ✅ CoreApi onAgentMessage addition (Task 4)
- ✅ Smoke test + plugin README (Task 15)

Tests added :
- `hook-spec-validation.test.ts` (Task 5) — 9 cases
- `hook-store.test.ts` (Task 6) — 9 cases
- `hook-event-bus.test.ts` (Task 7) — 6 cases

**Total**: ~24 new tests, plus existing 65 still green = 89 tests.

---

## Out of scope (explicitly deferred)

- Conditional log (filter args agent-side via predicate) — punted to v1.1.x.
- Custom JS snippet template — punted to v1.2 or beyond.
- Modify args template — punted.
- Auto-arm on attach — punted (safety).
- Hook templates UI in webview (vs Quick Pick) — punted.
- Multi-select install/uninstall in tree — punted.
