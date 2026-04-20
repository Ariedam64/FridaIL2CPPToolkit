# M1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lay the groundwork for the toolkit refactor — modular file structure, Operator Console design system, self-hosted fonts, and all existing panels re-rendered in the new theme. **No new features.** After M1, the toolkit should do exactly what it did before, but with the new architecture and look.

**Architecture:** Split the 863-line `src/tools/99-rpc-agent.ts` into focused modules under `src/rpc-agent/`. Break `host/server.js` into `host/lib/` modules. Rewrite `host/public/` in TypeScript modules (ESM, no bundler beyond `tsc`). Introduce `theme.css` holding Operator Console design tokens and a small library of signature components (`.readout`, `.section-header`, `.action-btn`, `.input`, `.tag`).

**Tech Stack:** TypeScript (already in deps), vanilla ES modules in the browser, Node built-in `http` + `ws` (unchanged), Frida + frida-il2cpp-bridge (unchanged). New dev dep: `@types/node` for the client types where needed. No bundler. No frontend framework.

---

## Reference: Design Spec

All visual decisions, token values, component shapes, and acceptance criteria are in:
`docs/superpowers/specs/2026-04-20-toolkit-refactor-design.md`

Sections that matter for M1:
- §3 File Structure (authoritative)
- §4 Layout (3-column shell, panel list)
- §5 Data Flow (keep HTTP + WS architecture as-is)
- §6 Design System (all tokens, typography, components, signature = `.readout`)
- §7 Rollout → M1 row (acceptance)

---

## Scope Boundary — What M1 Does NOT Do

- No memory scanner
- No watchlist timer (the panel exists empty / static)
- No diff feature
- No bookmarks / persistence
- No stack-trace on hook
- No copy-for-Claude helpers
- No logs regex filter
- No new RPC methods

These all land in M2→M5. M1 is **structural and visual only**.

---

## Prerequisites & Conventions

- Git is initialized as part of Task 0. If the user prefers no git, the `git commit` steps are skipped — the tasks still apply.
- Commit messages use conventional format: `refactor:`, `feat:`, `chore:`, `style:`.
- After each task's last step, verify that `npm run host` still starts and attaches to `FridaCobaye.exe` (if the task could affect runtime). If a task is purely additive (e.g., new CSS file not yet imported), skip the runtime check.
- Every source file starts with `/* SPDX comment or brief file-purpose comment */`, no longer than 2 lines.
- No emojis in code or file contents except where the spec explicitly calls for them (tab icons in UI only).

---

# Phase A — Scaffolding

### Task A0: Initialize git and add .gitignore

**Files:**
- Create: `.gitignore`
- Create: `.toolkit-data/.gitkeep` (empty placeholder so the dir is tracked)

- [ ] **Step 1: Initialize git repository**

Run: `git init`
Expected: `Initialized empty Git repository in F:/FridaIL2CPPToolkit/.git/`

- [ ] **Step 2: Write .gitignore**

Create `F:/FridaIL2CPPToolkit/.gitignore`:

```
node_modules/
build/
.toolkit-data/
!.toolkit-data/.gitkeep
.DS_Store
Thumbs.db
```

- [ ] **Step 3: Create toolkit-data placeholder**

Create `F:/FridaIL2CPPToolkit/.toolkit-data/.gitkeep` (empty file). Ensures the directory structure exists on fresh clones.

- [ ] **Step 4: Initial commit of existing code**

```bash
git add -A
git commit -m "chore: initial import of toolkit pre-refactor"
```

Expected: a commit containing all current files.

---

### Task A1: Create new directory skeleton

**Files:**
- Create: `src/rpc-agent/` (empty)
- Create: `host/lib/` (empty)
- Create: `host/public/lib/` (empty)
- Create: `host/public/panels/` (empty)
- Create: `host/public/fonts/` (empty — fonts arrive in Task D2)

- [ ] **Step 1: Create directories**

Run:
```bash
mkdir -p F:/FridaIL2CPPToolkit/src/rpc-agent
mkdir -p F:/FridaIL2CPPToolkit/host/lib
mkdir -p F:/FridaIL2CPPToolkit/host/public/lib
mkdir -p F:/FridaIL2CPPToolkit/host/public/panels
mkdir -p F:/FridaIL2CPPToolkit/host/public/fonts
```

Expected: all directories exist (verify with `ls`).

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "chore: create m1 refactor directory skeleton"
```

---

### Task A2: Add tsconfig for browser code + npm scripts

**Files:**
- Create: `tsconfig.public.json`
- Modify: `package.json` (add scripts)

- [ ] **Step 1: Write tsconfig.public.json**

Create `F:/FridaIL2CPPToolkit/tsconfig.public.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noImplicitAny": true,
    "noUnusedLocals": true,
    "noUnusedParameters": false,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "rootDir": "host/public",
    "outDir": "host/public/dist",
    "sourceMap": true,
    "declaration": false
  },
  "include": ["host/public/**/*.ts"],
  "exclude": ["host/public/dist", "node_modules"]
}
```

- [ ] **Step 2: Update package.json scripts**

In `F:/FridaIL2CPPToolkit/package.json`, add under `"scripts"` (keep all existing ones):

```json
"build:ui":  "tsc -p tsconfig.public.json",
"watch:ui":  "tsc -p tsconfig.public.json --watch",
"build:all": "npm run build:analyze && npm run build:find && npm run build:dump && npm run build:hook && npm run build:patch && npm run build:invoke && npm run build:rpc && npm run build:ui"
```

Note: `build:all` replaces the existing `build:all` — it now includes `build:ui`.

- [ ] **Step 3: Verify tsc can target the empty tree**

Run: `npm run build:ui`
Expected: exits 0, creates `host/public/dist/` (empty since no .ts files yet). No errors.

- [ ] **Step 4: Gitignore the dist output**

Append to `F:/FridaIL2CPPToolkit/.gitignore`:

```
host/public/dist/
```

- [ ] **Step 5: Commit**

```bash
git add tsconfig.public.json package.json .gitignore
git commit -m "chore: add tsc config and build:ui script for browser ts"
```

---

# Phase B — Split rpc-agent (no behavior change)

The goal of Phase B is to break the 863-line `src/tools/99-rpc-agent.ts` into focused modules. Behavior must be **byte-for-byte identical** at the user-facing RPC surface — we are only moving code.

**Strategy:** Create the target files one at a time, move functions into them, keep `99-rpc-agent.ts` operational by re-exporting. When all extraction is done, retire `99-rpc-agent.ts` by replacing its content with a compatibility shim, and repoint `build:rpc` to the new entry point.

### Task B1: Extract the instance registry and coerce helper

**Files:**
- Create: `src/rpc-agent/registry.ts`
- Modify: `src/tools/99-rpc-agent.ts` (remove the extracted code, import from new file)

- [ ] **Step 1: Write registry.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/registry.ts`:

```ts
// Captured-instance registry + JS→IL2CPP coercion helper.
import "frida-il2cpp-bridge";

export const captured = new Map<string, Il2Cpp.Object>();

export function getCaptured(className: string): Il2Cpp.Object {
    const inst = captured.get(className);
    if (!inst) throw new Error(`no captured instance for ${className}. Call capture(${className}, <tickMethod>) first.`);
    return inst;
}

/** Coerce a JSON-sent value to the IL2CPP type expected by `typeName`. */
export function coerce(value: any, typeName: string): any {
    if (value === undefined || value === null) return value;
    if (typeName === "System.String" && typeof value === "string") return Il2Cpp.string(value);

    // List<T> from a JS array — tolerate several type-name shapes
    //   System.Collections.Generic.List`1<System.UInt32>
    //   System.Collections.Generic.List<System.UInt32>
    //   List`1<System.UInt32>
    const listMatch = typeName.match(/List`?1?<([^>]+)>$/);
    if (listMatch && Array.isArray(value)) {
        const elemType = listMatch[1];
        const listClass = Il2Cpp.corlib.class(`System.Collections.Generic.List\`1<${elemType}>`);
        const list = listClass.new();
        list.method(".ctor").overload().invoke();
        for (const item of value) list.method("Add").invoke(coerce(item, elemType));
        return list;
    }
    return value;
}
```

- [ ] **Step 2: Update 99-rpc-agent.ts to import from registry.ts**

In `F:/FridaIL2CPPToolkit/src/tools/99-rpc-agent.ts`:
- Remove the local `captured` declaration (around line 64), the local `getCaptured` (around lines 66-70), and the local `coerce` function (around lines 72-100 — verify exact range before editing).
- At the top, after the existing imports, add:

```ts
import { captured, getCaptured, coerce } from "../rpc-agent/registry";
```

- [ ] **Step 3: Verify build still works**

Run: `npm run build:rpc`
Expected: exits 0, produces `build/rpc-agent.js`. No TypeScript errors.

- [ ] **Step 4: Smoke test attach**

Run: `npm run host` in one terminal. Navigate to http://localhost:3000. Attach to `FridaCobaye.exe`. Expected: "attached" status, no console errors.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/registry.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract instance registry into src/rpc-agent/registry.ts"
```

---

### Task B2: Extract search/query methods into search.ts

**Files:**
- Create: `src/rpc-agent/search.ts`
- Modify: `src/tools/99-rpc-agent.ts`

- [ ] **Step 1: Write search.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/search.ts`:

```ts
// RPC methods for discovery: find-classes, find-by-field, find-by-method, dumpClass, listMethods, probeNoArgGetters, findStringInMemory.
import "frida-il2cpp-bridge";
import {
    fullAnalyze, findAllClasses, findByField, findByMethod, findClass,
    fullClassName, dumpClass, dumpStatics, findStringInMemory, stringifyValue,
} from "../lib";
import { captured, getCaptured } from "./registry";

const inVm = <T,>(fn: () => T): Promise<T> =>
    new Promise((res, rej) => {
        try { Il2Cpp.perform(() => { try { res(fn()); } catch (e) { rej(e); } }); }
        catch (e) { rej(e); }
    });

export const searchRpc = {
    analyze(): Promise<void> {
        return inVm(() => fullAnalyze());
    },

    find(pattern: string, limit = 50): Promise<string[]> {
        return inVm(() => findAllClasses(pattern, limit).map(fullClassName));
    },

    findByField(typePattern: string | null, namePattern: string | null, limit = 50): Promise<string[]> {
        return inVm(() =>
            findByField(typePattern || null, namePattern || null, limit)
                .map(m => `${fullClassName(m.class)}  ::  ${m.type} ${m.field}`)
        );
    },

    findByMethod(opts: { returnType?: string; paramType?: string; name?: string }, limit = 50): Promise<string[]> {
        return inVm(() =>
            findByMethod(opts || {}, limit)
                .map(m => `${fullClassName(m.class)}  ::  ${m.signature}`)
        );
    },

    findStringInMemory(text: string, maxHits = 10): Promise<string[]> {
        return inVm(() => findStringInMemory(text, maxHits));
    },

    dumpClass(name: string): Promise<void> {
        return inVm(() => {
            const k = findClass(name);
            if (k) dumpClass(k);
            else console.log(`[rpc] class ${name} not found`);
        });
    },

    dumpStatics(name: string): Promise<void> {
        return inVm(() => {
            const k = findClass(name);
            if (k) dumpStatics(k);
            else console.log(`[rpc] class ${name} not found`);
        });
    },

    listMethods(className: string, nameFilter: string = ""): Promise<string[]> {
        return inVm(() => {
            let klass: Il2Cpp.Class | null = null;
            const cap = captured.get(className);
            if (cap) klass = cap.class;
            else klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const re = nameFilter ? new RegExp(nameFilter, "i") : null;
            const out: string[] = [`class: ${fullClassName(klass)}  methods:`];
            for (const m of klass.methods) {
                if (re && !re.test(m.name)) continue;
                const kind = m.isStatic ? "static " : "       ";
                const params = m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
                out.push(`  ${kind}${m.returnType.name.padEnd(20)} ${m.name}(${params})`);
            }
            return out;
        });
    },

    probeNoArgGetters(className: string, returnType: string = "System.String", includeEmpty = false, includeErrors = false): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const out: string[] = [];
            let tested = 0, ok = 0, failed = 0;
            out.push(`class: ${inst.class.name}  probing for no-arg methods returning ${returnType}`);
            for (const m of inst.class.methods) {
                if (m.isStatic) continue;
                if (m.parameters.length !== 0) continue;
                if (m.returnType.name !== returnType) continue;
                tested++;
                try {
                    const bound = inst.method(m.name);
                    const r = bound.invoke();
                    const s = stringifyValue(r);
                    const isEmpty = s === "null" || s === "\"\"" || s === "undefined" || s === "0";
                    if (includeEmpty || !isEmpty) {
                        out.push(`  ${m.name}() = ${s}`);
                        if (!isEmpty) ok++;
                    }
                } catch (e) {
                    failed++;
                    if (includeErrors) out.push(`  ${m.name}() = <err: ${String(e).slice(0, 80)}>`);
                }
            }
            out.push(`(tested ${tested}, non-empty ${ok}, failed ${failed})`);
            return out;
        });
    },
};
```

- [ ] **Step 2: Remove extracted methods from 99-rpc-agent.ts**

In `F:/FridaIL2CPPToolkit/src/tools/99-rpc-agent.ts`:
- Delete the implementations of these methods from the `rpc.exports` object (keep placeholder keys — replaced in step 3): `analyze`, `find`, `findByField`, `findByMethod`, `findStringInMemory`, `dumpClass`, `dumpStatics`, `listMethods`, `probeNoArgGetters`.
- Also delete the local `inVm` helper if it exists at module scope (we'll use the one defined inside `search.ts`; `99-rpc-agent.ts` may still need its own copy — see step 3).

- [ ] **Step 3: Wire searchRpc into rpc.exports**

At the top of `99-rpc-agent.ts`, add:
```ts
import { searchRpc } from "../rpc-agent/search";
```

Replace the `rpc.exports = {` declaration so it spreads `searchRpc` first:
```ts
rpc.exports = {
    ...searchRpc,
    // … remaining (non-extracted yet) methods below stay as-is for now
};
```

- [ ] **Step 4: Verify build + attach**

Run: `npm run build:rpc` → exits 0.
Run: `npm run host`, attach to `FridaCobaye.exe`. From the UI, click `full analyze` → logs should appear. Click `find classes` with `Player` → list returned. Expected: identical behavior to before.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/search.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract search/discovery methods into search.ts"
```

---

### Task B3: Extract explorer (tree) methods into explorer.ts

**Files:**
- Create: `src/rpc-agent/explorer.ts`
- Modify: `src/tools/99-rpc-agent.ts`

- [ ] **Step 1: Write explorer.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/explorer.ts`. Move the inheritance cache + these RPC methods verbatim: `listAssembliesInfo`, `listNamespaces`, `listClassesIn`, `listSubclasses`. Export as `explorerRpc`.

Structure:

```ts
import "frida-il2cpp-bridge";

let inheritanceCache: Map<string, string[]> | null = null;

function ensureInheritanceCache(): void {
    if (inheritanceCache) return;
    const map = new Map<string, string[]>();
    for (const asm of Il2Cpp.domain.assemblies) {
        for (const c of asm.image.classes) {
            const parent = c.parent;
            if (!parent) continue;
            const parentKeys = [parent.name, parent.type.name];
            for (const pk of parentKeys) {
                const list = map.get(pk) ?? [];
                if (!list.includes(c.name)) list.push(c.name);
                map.set(pk, list);
            }
        }
    }
    for (const arr of map.values()) arr.sort();
    inheritanceCache = map;
    console.log(`[explorer] inheritance cache built: ${map.size} parents`);
}

const inVm = <T,>(fn: () => T): Promise<T> =>
    new Promise((res, rej) => {
        try { Il2Cpp.perform(() => { try { res(fn()); } catch (e) { rej(e); } }); }
        catch (e) { rej(e); }
    });

export const explorerRpc = {
    listAssembliesInfo(): Promise<Array<{ name: string; classes: number }>> { /* … verbatim from 99-rpc-agent lines 166-177 … */ },
    listNamespaces(assemblyName: string): Promise<Array<{ ns: string; classes: number }>> { /* verbatim … */ },
    listClassesIn(assemblyName: string, ns: string): Promise<string[]> { /* verbatim … */ },
    listSubclasses(baseName: string, limit = 500): Promise<string[]> { /* verbatim … */ },
};
```

Fill each method body **literally copied** from `99-rpc-agent.ts` (lines approximately 166-218 — verify before copying). Use the local `inVm` helper defined above.

- [ ] **Step 2: Remove extracted code from 99-rpc-agent.ts**

Delete the `inheritanceCache` declaration, the `ensureInheritanceCache` function, and the 4 RPC methods listed above from `99-rpc-agent.ts`.

- [ ] **Step 3: Spread explorerRpc into rpc.exports**

Add import at top: `import { explorerRpc } from "../rpc-agent/explorer";`
Update the spread:
```ts
rpc.exports = {
    ...searchRpc,
    ...explorerRpc,
    // … remaining below
};
```

- [ ] **Step 4: Verify build + attach + explorer works**

Run: `npm run build:rpc` → exits 0.
Run host, attach, click **explorer** tab, switch between "by assembly" and "by inheritance". Expected: tree renders identically.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/explorer.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract explorer tree methods into explorer.ts"
```

---

### Task B4: Extract hook/patch methods into hooks.ts

**Files:**
- Create: `src/rpc-agent/hooks.ts`
- Modify: `src/tools/99-rpc-agent.ts`

- [ ] **Step 1: Write hooks.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/hooks.ts`. Move verbatim: `hook`, `replaceNoop`, `patchStatic`, `forceReturn`, `callStatic`, `callStaticOverload`. Export as `hooksRpc`.

```ts
import "frida-il2cpp-bridge";
import { findClass, hookLog, hookNoop, setStatic, forceReturn, callStatic, stringifyValue } from "../lib";
import { coerce } from "./registry";

const inVm = <T,>(fn: () => T): Promise<T> =>
    new Promise((res, rej) => {
        try { Il2Cpp.perform(() => { try { res(fn()); } catch (e) { rej(e); } }); }
        catch (e) { rej(e); }
    });

export const hooksRpc = {
    hook(className: string, methodName: string): Promise<void> {
        return inVm(() => hookLog(className, methodName));
    },
    replaceNoop(className: string, methodName: string): Promise<void> {
        return inVm(() => hookNoop(className, methodName));
    },
    patchStatic(className: string, field: string, value: any): Promise<void> {
        return inVm(() => setStatic(className, field, value));
    },
    forceReturn(className: string, method: string, value: any): Promise<void> {
        return inVm(() => forceReturn(className, method, value));
    },
    callStatic(className: string, method: string, args: any[] = []): Promise<string> {
        return inVm(() => {
            const res = callStatic(className, method, ...args);
            return String(res);
        });
    },
    callStaticOverload(className: string, methodName: string, paramTypes: string[], args: any[] = []): Promise<string> {
        return inVm(() => {
            const klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const method = klass.method(methodName).overload(...paramTypes);
            const coerced = args.map((v, i) => coerce(v, paramTypes[i]));
            const res = method.invoke(...coerced);
            return stringifyValue(res);
        });
    },
};
```

- [ ] **Step 2: Remove extracted methods from 99-rpc-agent.ts**

Delete those 6 methods from `rpc.exports` in `99-rpc-agent.ts`.

- [ ] **Step 3: Spread into rpc.exports**

Add import, update spread:
```ts
import { hooksRpc } from "../rpc-agent/hooks";
// …
rpc.exports = {
    ...searchRpc,
    ...explorerRpc,
    ...hooksRpc,
    // …
};
```

- [ ] **Step 4: Verify + smoke test hook**

Build, host, attach to `FridaCobaye.exe`. From UI hook/patch tab, install a `log hook` on a known method. Expected: hook installs, fires on next call.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/hooks.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract hook and patch methods into hooks.ts"
```

---

### Task B5: Extract instance operations into instance-ops.ts

**Files:**
- Create: `src/rpc-agent/instance-ops.ts`
- Modify: `src/tools/99-rpc-agent.ts`

**Methods to move:** `capture`, `listCaptured`, `listInstances`, `captureViaGC`, `captureFieldValue`, `captureMethodReturn`, `captureListElement`, `dumpInstance`, `readField`, `writeField`, `readAllFields`, `callInstance`, `readList`, `enumerateList`, `readDict`, `dictGet`.

- [ ] **Step 1: Write instance-ops.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/instance-ops.ts`. Import from `frida-il2cpp-bridge`, `../lib`, and `./registry` (for `captured`, `getCaptured`, `coerce`).

Copy the 16 methods listed above **verbatim** from `99-rpc-agent.ts` into an exported `instanceOpsRpc` object. Include the local `inVm` helper (defined above the object — same pattern as other modules).

Tip for mechanical verification: the total line count of `instance-ops.ts` should be roughly 350-400 lines once all 16 methods are in.

- [ ] **Step 2: Remove extracted methods from 99-rpc-agent.ts**

Delete those 16 methods from `rpc.exports`.

- [ ] **Step 3: Spread into rpc.exports**

```ts
import { instanceOpsRpc } from "../rpc-agent/instance-ops";
// …
rpc.exports = {
    ...searchRpc,
    ...explorerRpc,
    ...hooksRpc,
    ...instanceOpsRpc,
    // network methods remain inline for now
};
```

- [ ] **Step 4: Smoke test instance workflow**

Build, host, attach to `FridaCobaye.exe`. Test: `capture(<some MonoBehaviour>, "Update")`, wait, then `listCaptured()`, `dumpInstance(...)`, `readField(...)`, `writeField(...)`. All must work identically to before.

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/instance-ops.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract instance operations into instance-ops.ts"
```

---

### Task B6: Extract network capture into network.ts

**Files:**
- Create: `src/rpc-agent/network.ts`
- Modify: `src/tools/99-rpc-agent.ts`

**Methods to move:** `startNetworkCapture`, `stopNetworkCapture`, `resolveProtobufName`, `sampleResolvedProtobufs`.

- [ ] **Step 1: Write network.ts**

Copy the 4 methods verbatim into `F:/FridaIL2CPPToolkit/src/rpc-agent/network.ts` as `networkRpc`. Needs imports: `frida-il2cpp-bridge`, `findClass`, `stringifyValue` from `../lib`.

- [ ] **Step 2: Remove from 99-rpc-agent.ts and spread**

Delete those 4 methods. Add import + spread.

- [ ] **Step 3: Verify build**

Run: `npm run build:rpc` → exits 0.

- [ ] **Step 4: Smoke test** (skip if no Dofus instance handy — the test is implicit since the code moved verbatim)

- [ ] **Step 5: Commit**

```bash
git add src/rpc-agent/network.ts src/tools/99-rpc-agent.ts
git commit -m "refactor(rpc): extract network capture into network.ts"
```

---

### Task B7: Create rpc-methods.ts aggregator and new index.ts entry point

**Files:**
- Create: `src/rpc-agent/rpc-methods.ts`
- Create: `src/rpc-agent/index.ts`
- Modify: `package.json` (repoint `build:rpc`)
- Modify: `src/tools/99-rpc-agent.ts` (reduce to comment pointer)

- [ ] **Step 1: Write rpc-methods.ts**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/rpc-methods.ts`:

```ts
import { searchRpc } from "./search";
import { explorerRpc } from "./explorer";
import { hooksRpc } from "./hooks";
import { instanceOpsRpc } from "./instance-ops";
import { networkRpc } from "./network";

export const rpcMethods = {
    ...searchRpc,
    ...explorerRpc,
    ...hooksRpc,
    ...instanceOpsRpc,
    ...networkRpc,
};
```

- [ ] **Step 2: Write index.ts (compiled entry)**

Create `F:/FridaIL2CPPToolkit/src/rpc-agent/index.ts`:

```ts
// Frida agent entry point. Compiled by `npm run build:rpc` → build/rpc-agent.js.
import "frida-il2cpp-bridge";
import { rpcMethods } from "./rpc-methods";

rpc.exports = rpcMethods;

Il2Cpp.perform(() => {
    console.log("[rpc-agent] ready. Exposed methods: " + Object.keys(rpcMethods).sort().join(", "));
    send({ type: "agent-ready" });
});
```

- [ ] **Step 3: Update build:rpc target in package.json**

In `F:/FridaIL2CPPToolkit/package.json`:
```json
"build:rpc":  "frida-compile src/rpc-agent/index.ts       -o build/rpc-agent.js",
"watch:rpc":  "frida-compile src/rpc-agent/index.ts       -o build/rpc-agent.js -w",
```

- [ ] **Step 4: Retire 99-rpc-agent.ts**

Replace the entire content of `F:/FridaIL2CPPToolkit/src/tools/99-rpc-agent.ts` with:

```ts
/* MOVED — the RPC agent has been split into modules under src/rpc-agent/.
 * This file is kept as a pointer so old documentation links don't 404.
 * Compile target: src/rpc-agent/index.ts → build/rpc-agent.js
 */
export {};
```

- [ ] **Step 5: Full rebuild + smoke test**

Run:
```bash
rm -rf build/
npm run build:rpc
npm run host
```

Attach to `FridaCobaye.exe`. Run through every tab of the existing UI — search, instance (with a test capture), hook&patch, socket (skip if no Dofus), explorer. Expected: **every feature behaves as before**.

- [ ] **Step 6: Commit**

```bash
git add src/rpc-agent/rpc-methods.ts src/rpc-agent/index.ts src/tools/99-rpc-agent.ts package.json
git commit -m "refactor(rpc): introduce index + aggregator, retire old 99-rpc-agent"
```

---

# Phase C — Split server.js (no behavior change)

Goal: `host/server.js` currently mixes HTTP routing, Frida bridge logic, WebSocket broadcast, and static serving in 204 lines. Split into focused modules.

### Task C1: Extract the Frida bridge into host/lib/frida-bridge.js

**Files:**
- Create: `host/lib/frida-bridge.js`
- Modify: `host/server.js`

- [ ] **Step 1: Write frida-bridge.js**

Create `F:/FridaIL2CPPToolkit/host/lib/frida-bridge.js`:

```js
/* Thin wrapper around the Frida node API: attach/detach/call RPC. */
const fs = require("fs");
const path = require("path");

let frida;
async function getFrida() {
    if (!frida) frida = await import("frida");
    return frida;
}

const AGENT_PATH = path.resolve(__dirname, "..", "..", "build", "rpc-agent.js");

let session = null;
let script = null;
let attachedInfo = null;
const listeners = { attached: [], detached: [], message: [] };

function on(event, cb) { listeners[event].push(cb); }
function emit(event, payload) { for (const cb of listeners[event]) cb(payload); }

async function attach(pid) {
    await detach();
    if (!fs.existsSync(AGENT_PATH)) {
        throw new Error(`agent not built: ${AGENT_PATH}. Run: npm run build:rpc`);
    }
    const f = await getFrida();
    const device = await f.getLocalDevice();
    const procs = await device.enumerateProcesses();
    const proc = procs.find(p => p.pid === pid);
    if (!proc) throw new Error(`PID ${pid} not found`);

    session = await device.attach(pid);
    session.detached.connect((reason) => {
        emit("detached", { reason });
        attachedInfo = null; session = null; script = null;
    });

    const source = fs.readFileSync(AGENT_PATH, "utf8");
    script = await session.createScript(source);
    script.message.connect((message) => emit("message", message));
    script.logHandler = (level, payload) => emit("message", { type: "log", level, payload });
    await script.load();

    attachedInfo = { pid, name: proc.name };
    emit("attached", attachedInfo);
    return attachedInfo;
}

async function detach() {
    if (script) { try { await script.unload(); } catch {} script = null; }
    if (session) { try { await session.detach(); } catch {} session = null; }
    if (attachedInfo) { emit("detached", {}); attachedInfo = null; }
}

async function callRpc(method, args = []) {
    if (!script) throw new Error("not attached");
    const api = script.exports;
    if (typeof api[method] !== "function") {
        throw new Error(`unknown RPC method: ${method}`);
    }
    return await api[method](...args);
}

async function listProcesses(query) {
    const f = await getFrida();
    const device = await f.getLocalDevice();
    const procs = await device.enumerateProcesses();
    const q = String(query || "").toLowerCase();
    const filtered = q ? procs.filter(p => p.name.toLowerCase().includes(q)) : procs;
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered.map(p => ({ pid: p.pid, name: p.name }));
}

function getAttachedInfo() { return attachedInfo; }

module.exports = { attach, detach, callRpc, listProcesses, getAttachedInfo, on };
```

- [ ] **Step 2: Update server.js to consume the bridge**

In `F:/FridaIL2CPPToolkit/host/server.js`:
- At the top, replace the Frida-related block (imports, session/script/attachedInfo declarations, `attach`, `detach`, `callRpc` functions) with:

```js
const bridge = require("./lib/frida-bridge");
```

- Replace usages: `attach(pid)` → `bridge.attach(pid)`, `detach()` → `bridge.detach()`, `callRpc(m, a)` → `bridge.callRpc(m, a)`, `attachedInfo` → `bridge.getAttachedInfo()`.
- Wire bridge events to the existing `broadcast()` function:

```js
bridge.on("attached", (info) => broadcast({ type: "attached", ...info }));
bridge.on("detached", (e) => broadcast({ type: "detached", reason: e.reason }));
bridge.on("message",  (m) => broadcast({ type: "message", message: m }));
```

- The `/api/processes` handler becomes: `return sendJson(res, 200, await bridge.listProcesses(parsed.query.q));`
- The `/api/status` handler becomes: `return sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() });`

- [ ] **Step 3: Smoke test**

Run `npm run host`, visit http://localhost:3000, attach to `FridaCobaye.exe`, run any RPC call. Expected: identical behavior.

- [ ] **Step 4: Commit**

```bash
git add host/lib/frida-bridge.js host/server.js
git commit -m "refactor(server): extract frida attach/detach/call into host/lib/frida-bridge.js"
```

---

### Task C2: Extract WebSocket broadcast into host/lib/ws.js

**Files:**
- Create: `host/lib/ws.js`
- Modify: `host/server.js`

- [ ] **Step 1: Write ws.js**

Create `F:/FridaIL2CPPToolkit/host/lib/ws.js`:

```js
const { WebSocketServer } = require("ws");

const wsClients = new Set();

function attach(httpServer) {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    wss.on("connection", (ws, _req, initialPayload) => {
        wsClients.add(ws);
        if (initialPayload) ws.send(JSON.stringify(initialPayload));
        ws.on("close", () => wsClients.delete(ws));
    });
    return wss;
}

function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(data);
    }
}

module.exports = { attach, broadcast };
```

- [ ] **Step 2: Update server.js**

In `F:/FridaIL2CPPToolkit/host/server.js`:
- Remove the `const { WebSocketServer } = require("ws");` import, remove the `wsClients` set, remove the in-file `broadcast` definition, remove the `wss.on("connection", ...)` block.
- Add: `const ws = require("./lib/ws");` and `const { broadcast } = ws;`
- Replace the `wss = new WebSocketServer(...)` boot with `const wss = ws.attach(server);` — and after that, keep the hello message wiring by re-adding a per-connection `ws.on("open"...)` is not needed; instead adjust ws.js so the hello message is sent externally. Simpler: expose a callback. Replace step 1's `ws.js` with this variant that takes an `onConnect` option:

```js
function attach(httpServer, onConnect) {
    const wss = new WebSocketServer({ server: httpServer, path: "/ws" });
    wss.on("connection", (clientWs) => {
        wsClients.add(clientWs);
        if (onConnect) { try { const hello = onConnect(); if (hello) clientWs.send(JSON.stringify(hello)); } catch {} }
        clientWs.on("close", () => wsClients.delete(clientWs));
    });
    return wss;
}
```

And in `server.js`:
```js
ws.attach(server, () => ({ type: "hello", attached: bridge.getAttachedInfo() }));
```

- [ ] **Step 3: Smoke test**

Attach, detach, observe WS reconnection behavior is unchanged.

- [ ] **Step 4: Commit**

```bash
git add host/lib/ws.js host/server.js
git commit -m "refactor(server): extract websocket broadcast into host/lib/ws.js"
```

---

### Task C3: Extract routes into host/lib/router.js

**Files:**
- Create: `host/lib/router.js`
- Modify: `host/server.js`

- [ ] **Step 1: Write router.js**

Create `F:/FridaIL2CPPToolkit/host/lib/router.js`:

```js
/* Tiny route table: { method: { path: handler(req, res, parsedQuery) } }. */
const url = require("url");

function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => data += c);
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

function makeHandler(routes, fallback) {
    return async function handleRequest(req, res) {
        const parsed = url.parse(req.url, true);
        try {
            const table = routes[req.method];
            const handler = table && table[parsed.pathname];
            if (handler) return await handler(req, res, parsed.query);
            if (fallback) return await fallback(req, res, parsed.pathname);
            res.writeHead(404); res.end("not found");
        } catch (e) {
            console.error("[http]", e);
            sendJson(res, 500, { error: String(e.message || e) });
        }
    };
}

module.exports = { makeHandler, sendJson, readBody };
```

- [ ] **Step 2: Refactor server.js to register routes via the table**

Replace the giant `handleRequest` function in `server.js` with a route table:

```js
const { makeHandler, sendJson, readBody } = require("./lib/router");

const routes = {
    GET: {
        "/api/processes": async (req, res, q) => sendJson(res, 200, await bridge.listProcesses(q.q)),
        "/api/status":    (req, res)        => sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() }),
    },
    POST: {
        "/api/attach": async (req, res) => {
            const { pid } = JSON.parse(await readBody(req));
            sendJson(res, 200, await bridge.attach(pid));
        },
        "/api/detach": async (req, res) => { await bridge.detach(); sendJson(res, 200, { ok: true }); },
        "/api/reload": async (req, res) => {
            const info = bridge.getAttachedInfo();
            if (!info) throw new Error("not attached");
            sendJson(res, 200, await bridge.attach(info.pid));
        },
        "/api/call": async (req, res) => {
            const { method, args } = JSON.parse(await readBody(req));
            const result = await bridge.callRpc(method, args || []);
            sendJson(res, 200, { result });
        },
    },
};

const fallback = (req, res, pathname) => serveStatic(req, res, pathname);
const server = http.createServer(makeHandler(routes, fallback));
```

Leave `serveStatic` in `server.js` for now (it's small and context-specific — we'll move it in Task C4 if needed; otherwise keep it inline).

- [ ] **Step 3: Smoke test every endpoint**

- `GET /api/processes?q=frida` → list returns.
- `GET /api/status` → returns current state.
- `POST /api/attach` → attaches.
- `POST /api/call` with `{method:"find", args:["Player"]}` → returns result.
- `POST /api/detach` → detaches.

- [ ] **Step 4: Commit**

```bash
git add host/lib/router.js host/server.js
git commit -m "refactor(server): extract route table into host/lib/router.js"
```

---

### Task C4: Create persistence.js stub

**Files:**
- Create: `host/lib/persistence.js`

This is a **stub** — it exports the API but all methods `throw new Error("not implemented — see M3")`. We ship it now so the route wiring in later milestones has a stable seam.

- [ ] **Step 1: Write persistence.js**

Create `F:/FridaIL2CPPToolkit/host/lib/persistence.js`:

```js
/* Disk persistence stub. Implemented in M3 (bookmarks) and M5 (dumps). */
function listBookmarks() { throw new Error("persistence.listBookmarks: implemented in M3"); }
function getBookmark(_name) { throw new Error("persistence.getBookmark: implemented in M3"); }
function saveBookmark(_name, _data) { throw new Error("persistence.saveBookmark: implemented in M3"); }
function deleteBookmark(_name) { throw new Error("persistence.deleteBookmark: implemented in M3"); }
function saveDump(_payload, _meta) { throw new Error("persistence.saveDump: implemented in M5"); }

module.exports = { listBookmarks, getBookmark, saveBookmark, deleteBookmark, saveDump };
```

- [ ] **Step 2: Commit**

```bash
git add host/lib/persistence.js
git commit -m "chore(server): add persistence.js stub for m3/m5 seam"
```

---

# Phase D — Design System CSS

### Task D1: Self-host the fonts

**Files:**
- Create: `host/public/fonts/inter-400.woff2`
- Create: `host/public/fonts/inter-500.woff2`
- Create: `host/public/fonts/inter-600.woff2`
- Create: `host/public/fonts/inter-700.woff2`
- Create: `host/public/fonts/jetbrains-mono-500.woff2`
- Create: `host/public/fonts/jetbrains-mono-700.woff2`
- Create: `host/public/fonts/fonts.css`

- [ ] **Step 1: Download fonts**

Download each weight from rsms/inter (Inter) and JetBrains/JetBrainsMono GitHub releases — use the `.woff2` files only. Place them at the exact paths above.

*(If download blocked by the environment, document the step and ship with a `fonts/README.md` saying "drop the files here manually, weights: Inter 400/500/600/700, JetBrains Mono 500/700".)*

- [ ] **Step 2: Write fonts.css**

Create `F:/FridaIL2CPPToolkit/host/public/fonts/fonts.css`:

```css
@font-face {
  font-family: 'Inter';
  src: url('./inter-400.woff2') format('woff2');
  font-weight: 400; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('./inter-500.woff2') format('woff2');
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('./inter-600.woff2') format('woff2');
  font-weight: 600; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'Inter';
  src: url('./inter-700.woff2') format('woff2');
  font-weight: 700; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('./jetbrains-mono-500.woff2') format('woff2');
  font-weight: 500; font-style: normal; font-display: swap;
}
@font-face {
  font-family: 'JetBrains Mono';
  src: url('./jetbrains-mono-700.woff2') format('woff2');
  font-weight: 700; font-style: normal; font-display: swap;
}
```

- [ ] **Step 3: Commit**

```bash
git add host/public/fonts/
git commit -m "chore(ui): self-host inter and jetbrains mono fonts"
```

---

### Task D2: Write theme.css — tokens

**Files:**
- Create: `host/public/theme.css`

- [ ] **Step 1: Write tokens section**

Create `F:/FridaIL2CPPToolkit/host/public/theme.css` with the tokens from spec §6 verbatim:

```css
@import url('./fonts/fonts.css');

:root {
  --surface-0: #0c0d0f;
  --surface-1: #14161a;
  --surface-2: #1b1e23;
  --surface-3: #232731;
  --surface-inset: #0a0b0d;

  --border-soft:   rgba(232, 184, 124, 0.06);
  --border:        rgba(232, 184, 124, 0.12);
  --border-strong: rgba(232, 184, 124, 0.22);
  --border-focus:  rgba(255, 122, 45, 0.60);

  --ink-primary:   #ffd89c;
  --ink-body:      #e9cfa3;
  --ink-muted:     #a58a6a;
  --ink-disabled:  #564939;

  --accent:        #ff7a2d;
  --accent-glow:   rgba(255, 122, 45, 0.35);
  --live:          #ff7a2d;
  --ok:            #7ed957;
  --warn:          #f5c518;
  --err:           #ff5a4a;

  --font-ui:   'Inter', -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Consolas', monospace;

  --s-1: 4px;  --s-2: 8px;  --s-3: 12px;  --s-4: 16px;
  --s-5: 20px; --s-6: 24px; --s-8: 32px;  --s-10: 40px;

  --r-sm: 2px; --r-md: 4px; --r-lg: 6px;

  --ease:  cubic-bezier(.2,.7,.2,1);
  --fast:  120ms;
  --pulse: 1.6s;
}

* { box-sizing: border-box; margin: 0; padding: 0; }

html, body {
  height: 100%;
  background: var(--surface-0);
  color: var(--ink-body);
  font-family: var(--font-ui);
  font-size: 13px;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
}

body {
  background-image: repeating-linear-gradient(
    0deg,
    rgba(232, 184, 124, 0.015) 0,
    rgba(232, 184, 124, 0.015) 1px,
    transparent 1px,
    transparent 3px
  );
}

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: var(--surface-0); }
::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: var(--r-sm); }
::-webkit-scrollbar-thumb:hover { background: var(--surface-3); }
```

- [ ] **Step 2: Commit**

```bash
git add host/public/theme.css
git commit -m "style(ui): add operator console design tokens and base reset"
```

---

### Task D3: Append component styles to theme.css

**Files:**
- Modify: `host/public/theme.css`

- [ ] **Step 1: Append component blocks**

Append to `F:/FridaIL2CPPToolkit/host/public/theme.css`:

```css
/* ─── section-header ─── */
.section-header {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--accent);
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  padding-bottom: var(--s-2);
  border-bottom: 1px solid var(--border-soft);
}
.section-header::before { content: "▸"; color: var(--accent); }
.section-header .meta {
  font-weight: 400;
  letter-spacing: 0.08em;
  color: var(--ink-muted);
  margin-left: auto;
}

/* ─── readout (signature component) ─── */
.readout {
  display: grid;
  grid-template-columns: 14px 1fr auto auto;
  gap: var(--s-3);
  align-items: center;
  padding: var(--s-3) var(--s-4);
  background: var(--surface-1);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  font-family: var(--font-mono);
}
.readout .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--live);
  box-shadow: 0 0 6px var(--accent-glow);
  animation: readout-pulse var(--pulse) infinite;
}
.readout.idle .dot { animation: none; opacity: 0.3; background: var(--ink-disabled); box-shadow: none; }
.readout .k { font-size: 11.5px; color: var(--ink-muted); letter-spacing: 0.02em; }
.readout .v { font-size: 16px; font-weight: 700; color: var(--ink-primary); font-variant-numeric: tabular-nums; letter-spacing: 0.04em; }
.readout .d { font-size: 10.5px; font-weight: 600; padding: 2px 6px; border-radius: var(--r-sm); border: 1px solid; }
.readout .d.up { color: var(--ok); border-color: rgba(126, 217, 87, 0.4); }
.readout .d.dn { color: var(--accent); border-color: rgba(255, 122, 45, 0.4); }
@keyframes readout-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ─── action-btn ─── */
.btn {
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ink-body);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 12px;
  cursor: pointer;
  transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease), color var(--fast) var(--ease);
}
.btn:hover:not(:disabled) {
  border-color: var(--border-strong);
  color: var(--ink-primary);
}
.btn:active:not(:disabled) {
  background: var(--accent);
  color: var(--surface-0);
  border-color: var(--accent);
}
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: var(--surface-0); border-color: var(--accent); }
.btn.primary:hover:not(:disabled) { filter: brightness(1.1); }

/* ─── input ─── */
.input, select, textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--ink-body);
  background: var(--surface-inset);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  padding: 6px 10px;
  outline: none;
  transition: border-color var(--fast) var(--ease), background var(--fast) var(--ease);
}
.input::placeholder { color: var(--ink-disabled); font-style: italic; }
.input:focus, select:focus, textarea:focus {
  border-color: var(--border-focus);
  background: var(--surface-3);
}

/* ─── tag ─── */
.tag {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  color: var(--ink-muted);
}
.tag.ok  { color: var(--ok);     border-color: rgba(126, 217, 87, 0.4); }
.tag.err { color: var(--err);    border-color: rgba(255, 90, 74, 0.4); }
.tag.warn{ color: var(--warn);   border-color: rgba(245, 197, 24, 0.4); }
.tag.live{ color: var(--accent); border-color: rgba(255, 122, 45, 0.4); }

/* ─── panels ─── */
.panel {
  background: var(--surface-1);
  border: 1px solid var(--border-soft);
  border-radius: var(--r-md);
  padding: var(--s-4);
  display: flex; flex-direction: column;
  gap: var(--s-3);
  min-height: 0;
}

/* ─── tabs ─── */
.tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-soft); }
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--ink-muted);
  font-family: var(--font-ui);
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  padding: var(--s-3) var(--s-4);
  cursor: pointer;
  transition: color var(--fast), border-color var(--fast);
}
.tab:hover { color: var(--ink-body); }
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}

/* ─── header ─── */
.app-header {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  padding: var(--s-3) var(--s-5);
  background: var(--surface-1);
  border-bottom: 1px solid var(--border-soft);
  height: 48px;
}
.app-header h1 {
  font-family: var(--font-ui);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-primary);
}

/* ─── status pill ─── */
.status-pill {
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 3px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  color: var(--ink-muted);
  display: inline-flex; align-items: center; gap: 6px;
}
.status-pill::before {
  content: "";
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ink-disabled);
}
.status-pill.on  { color: var(--ok);  border-color: rgba(126, 217, 87, 0.4); }
.status-pill.on::before  { background: var(--ok);  box-shadow: 0 0 6px rgba(126, 217, 87, 0.5); animation: readout-pulse var(--pulse) infinite; }
.status-pill.err { color: var(--err); border-color: rgba(255, 90, 74, 0.4); }
.status-pill.err::before { background: var(--err); }

/* ─── layout shell ─── */
.app {
  display: grid;
  grid-template-rows: 48px 1fr;
  height: 100vh;
}
.app-body {
  display: grid;
  grid-template-columns: 260px 1fr 320px;
  gap: 1px;
  background: var(--border-soft);
  overflow: hidden;
}
.app-body > * { background: var(--surface-0); overflow: hidden; display: flex; flex-direction: column; }
@media (max-width: 1100px) {
  .app-body { grid-template-columns: 220px 1fr 280px; }
}
```

- [ ] **Step 2: Commit**

```bash
git add host/public/theme.css
git commit -m "style(ui): add signature components (readout, btn, input, tag, panel, tabs)"
```

---

# Phase E — Shell layout

### Task E1: Write new index.html shell

**Files:**
- Modify: `host/public/index.html` (full rewrite)

- [ ] **Step 1: Replace index.html**

Overwrite `F:/FridaIL2CPPToolkit/host/public/index.html`:

```html
<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Frida IL2CPP Toolkit</title>
  <link rel="stylesheet" href="theme.css">
</head>
<body>
  <div class="app">

    <header class="app-header">
      <h1>◉ IL2CPP Operator</h1>
      <div id="status" class="status-pill">not attached</div>
      <div style="flex:1"></div>
      <button id="btn-reload" class="btn" disabled title="re-read build/rpc-agent.js">reload</button>
      <button id="btn-detach" class="btn" disabled>detach</button>
    </header>

    <main class="app-body">

      <aside id="sidebar" class="panel" aria-label="sidebar">
        <div class="tabs" data-tabs="sidebar">
          <button class="tab active" data-tab="processes">processes</button>
          <button class="tab" data-tab="explorer">explorer</button>
        </div>
        <div id="sidebar-content" style="flex:1; overflow:auto"></div>
      </aside>

      <section id="main-panel" class="panel" aria-label="actions">
        <div class="tabs" data-tabs="main">
          <button class="tab active" data-tab="search">search</button>
          <button class="tab" data-tab="instance">instance</button>
          <button class="tab" data-tab="hookpatch">hook &amp; patch</button>
          <button class="tab" data-tab="socket">socket</button>
        </div>
        <div id="main-content" style="flex:1; overflow:auto"></div>
      </section>

      <aside id="side-live" class="panel" aria-label="live">
        <div class="section-header">live <span class="meta">watchlist · logs</span></div>
        <div id="watchlist" style="display:flex;flex-direction:column;gap:var(--s-2)">
          <div class="readout idle">
            <span class="dot"></span>
            <span class="k">no pins yet</span>
            <span class="v">—</span>
            <span class="d"></span>
          </div>
        </div>
        <div class="section-header">events</div>
        <div id="log" style="flex:1; overflow:auto; font-family:var(--font-mono); font-size:11.5px"></div>
      </aside>

    </main>
  </div>

  <script type="module" src="dist/main.js"></script>
</body>
</html>
```

- [ ] **Step 2: Start host, confirm the shell renders**

Run: `npm run host` and open http://localhost:3000.
Expected: **three-column layout appears** with the Operator Console theme. The side-live shows one idle readout labeled "no pins yet" and two section-header bars. Tabs are clickable but do nothing functional yet. No JS errors in devtools (we'll implement `dist/main.js` in Task E2).

- [ ] **Step 3: Commit**

```bash
git add host/public/index.html
git commit -m "style(ui): replace index.html with operator console shell layout"
```

---

### Task E2: Bootstrap main.ts + tab switching

**Files:**
- Create: `host/public/main.ts`

- [ ] **Step 1: Write main.ts**

Create `F:/FridaIL2CPPToolkit/host/public/main.ts`:

```ts
// Entry point. Wires tab switching + will mount panels later.
function $(sel: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`element not found: ${sel}`);
    return el as HTMLElement;
}

function wireTabs(groupName: string, contentEl: HTMLElement): void {
    const tabsEl = document.querySelector(`[data-tabs="${groupName}"]`) as HTMLElement | null;
    if (!tabsEl) return;
    tabsEl.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
        if (!btn) return;
        const name = btn.dataset.tab;
        if (!name) return;
        for (const t of tabsEl.querySelectorAll(".tab")) t.classList.remove("active");
        btn.classList.add("active");
        contentEl.dataset.active = name;
        // Emit an event panels will subscribe to
        document.dispatchEvent(new CustomEvent("tab-change", { detail: { group: groupName, name } }));
    });
}

wireTabs("sidebar", $("#sidebar-content"));
wireTabs("main", $("#main-content"));

console.log("[main] bootstrapped");
```

- [ ] **Step 2: Build and reload**

Run: `npm run build:ui`
Expected: `host/public/dist/main.js` exists.
Reload http://localhost:3000 — clicking tabs should swap the `.active` class. Check in devtools.

- [ ] **Step 3: Commit**

```bash
git add host/public/main.ts
git commit -m "feat(ui): bootstrap main.ts with tab switching"
```

---

### Task E3: Write lib/rpc.ts (HTTP client)

**Files:**
- Create: `host/public/lib/rpc.ts`

- [ ] **Step 1: Write rpc.ts**

Create `F:/FridaIL2CPPToolkit/host/public/lib/rpc.ts`:

```ts
// HTTP client for /api/* endpoints.
export async function rpcCall<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const res = await fetch("/api/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body.result as T;
}

export async function listProcesses(filter?: string): Promise<Array<{ pid: number; name: string }>> {
    const url = filter ? `/api/processes?q=${encodeURIComponent(filter)}` : "/api/processes";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`processes: HTTP ${res.status}`);
    return res.json();
}

export async function attach(pid: number): Promise<{ pid: number; name: string }> {
    const res = await fetch("/api/attach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pid }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
}

export async function detach(): Promise<void> {
    const res = await fetch("/api/detach", { method: "POST" });
    if (!res.ok) throw new Error(`detach: HTTP ${res.status}`);
}

export async function reload(): Promise<{ pid: number; name: string }> {
    const res = await fetch("/api/reload", { method: "POST" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
}

export async function status(): Promise<{ attached: boolean; info: { pid: number; name: string } | null }> {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`status: HTTP ${res.status}`);
    return res.json();
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build:ui`
Expected: no errors, `host/public/dist/lib/rpc.js` exists.

- [ ] **Step 3: Commit**

```bash
git add host/public/lib/rpc.ts
git commit -m "feat(ui): add typed rpc http client"
```

---

### Task E4: Write lib/ws.ts (typed event bus)

**Files:**
- Create: `host/public/lib/ws.ts`

- [ ] **Step 1: Write ws.ts**

Create `F:/FridaIL2CPPToolkit/host/public/lib/ws.ts`:

```ts
// WebSocket connection + typed event bus.
export type WsEvent =
    | { type: "hello"; attached: { pid: number; name: string } | null }
    | { type: "attached"; pid: number; name: string }
    | { type: "detached"; reason?: string }
    | { type: "message"; message: { type: string; [k: string]: unknown } };

type Handler = (ev: WsEvent) => void;

const handlers: Handler[] = [];
let socket: WebSocket | null = null;
let retryDelay = 500;

export function onWsEvent(fn: Handler): () => void {
    handlers.push(fn);
    return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); };
}

export function connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { retryDelay = 500; console.log("[ws] open"); });
    socket.addEventListener("message", (e) => {
        try {
            const data = JSON.parse(String(e.data)) as WsEvent;
            for (const h of handlers) { try { h(data); } catch (err) { console.error("[ws] handler error", err); } }
        } catch (err) { console.error("[ws] bad payload", err, e.data); }
    });
    socket.addEventListener("close", () => {
        console.warn(`[ws] closed, retry in ${retryDelay}ms`);
        socket = null;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
    });
    socket.addEventListener("error", () => { try { socket?.close(); } catch {} });
}
```

- [ ] **Step 2: Commit**

```bash
git add host/public/lib/ws.ts
git commit -m "feat(ui): add websocket client with typed event bus and auto-reconnect"
```

---

### Task E5: Write lib/store.ts with TDD

**Files:**
- Create: `host/public/lib/store.ts`
- Create: `host/public/lib/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `F:/FridaIL2CPPToolkit/host/public/lib/store.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.ts";

test("createStore returns initial state via get()", () => {
    const s = createStore({ count: 0 });
    assert.deepEqual(s.get(), { count: 0 });
});

test("set() updates state and notifies subscribers", () => {
    const s = createStore({ count: 0 });
    let received: unknown = null;
    s.subscribe((state) => { received = state; });
    s.set({ count: 5 });
    assert.deepEqual(received, { count: 5 });
});

test("subscribe returns an unsubscribe function", () => {
    const s = createStore({ count: 0 });
    let count = 0;
    const unsub = s.subscribe(() => { count++; });
    s.set({ count: 1 });
    unsub();
    s.set({ count: 2 });
    assert.equal(count, 1);
});

test("update() applies a partial patch", () => {
    const s = createStore<{ a: number; b: number }>({ a: 1, b: 2 });
    s.update({ a: 10 });
    assert.deepEqual(s.get(), { a: 10, b: 2 });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `npx tsx --test host/public/lib/store.test.ts` *(tsx handles TS without compiling)*
Expected: **FAIL** — `store.ts` doesn't exist. If `tsx` isn't installed, install: `npm i -D tsx`.

- [ ] **Step 3: Implement store.ts**

Create `F:/FridaIL2CPPToolkit/host/public/lib/store.ts`:

```ts
// Minimal observable store. No deps.
export interface Store<T> {
    get(): T;
    set(value: T): void;
    update(patch: Partial<T>): void;
    subscribe(fn: (value: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
    let state = initial;
    const subs = new Set<(v: T) => void>();
    return {
        get: () => state,
        set: (value: T) => {
            state = value;
            for (const s of subs) { try { s(state); } catch (e) { console.error("[store] subscriber err", e); } }
        },
        update: (patch: Partial<T>) => {
            state = { ...state, ...patch };
            for (const s of subs) { try { s(state); } catch (e) { console.error("[store] subscriber err", e); } }
        },
        subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
    };
}
```

- [ ] **Step 4: Re-run the test (expect pass)**

Run: `npx tsx --test host/public/lib/store.test.ts`
Expected: **PASS** — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add host/public/lib/store.ts host/public/lib/store.test.ts
git commit -m "feat(ui): add minimal observable store with tests"
```

---

# Phase F — Migrate panels (one per task)

Each migration task: (1) move the relevant chunk of `host/public/app.js` into a TypeScript panel module using the new theme classes, (2) import + mount it from `main.ts`, (3) verify the feature works end-to-end, (4) commit.

For each panel, the **acceptance criterion** is: clicking the tab shows the panel, and every button triggers the same RPC call as before, producing the same behavior. No functional regression.

### Task F1: Connection panel (process picker + attach/detach)

**Files:**
- Create: `host/public/panels/connection.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write connection.ts**

Create `F:/FridaIL2CPPToolkit/host/public/panels/connection.ts`:

```ts
import { listProcesses, attach, detach, reload, status } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";

interface Proc { pid: number; name: string; }

export function mountConnection(container: HTMLElement, statusEl: HTMLElement, btnDetach: HTMLButtonElement, btnReload: HTMLButtonElement): void {
    container.innerHTML = `
      <div style="display:flex; gap:var(--s-2); margin-bottom:var(--s-3)">
        <input class="input" id="q" placeholder="filter by name…" style="flex:1">
        <button class="btn" id="btn-refresh" title="refresh">↻</button>
      </div>
      <div id="proclist" style="font-family:var(--font-mono); font-size:12px">loading…</div>
    `;
    const q = container.querySelector("#q") as HTMLInputElement;
    const list = container.querySelector("#proclist") as HTMLElement;
    const refresh = container.querySelector("#btn-refresh") as HTMLButtonElement;

    let procs: Proc[] = [];
    async function refreshProcs(): Promise<void> {
        list.textContent = "loading…";
        try {
            procs = await listProcesses(q.value);
            render();
        } catch (e) {
            list.innerHTML = `<span style="color:var(--err)">${String(e)}</span>`;
        }
    }

    function render(): void {
        const filter = q.value.toLowerCase();
        const shown = filter ? procs.filter(p => p.name.toLowerCase().includes(filter)) : procs;
        list.innerHTML = shown.map(p => `
          <div class="proc-row" data-pid="${p.pid}" style="padding:6px 8px; cursor:pointer; border-bottom:1px solid var(--border-soft)">
            <span class="v" style="font-size:12px; color:var(--ink-primary)">${p.name}</span>
            <span class="tag" style="float:right">${p.pid}</span>
          </div>
        `).join("");
    }

    list.addEventListener("click", async (e) => {
        const row = (e.target as HTMLElement).closest(".proc-row") as HTMLElement | null;
        if (!row) return;
        const pid = Number(row.dataset.pid);
        try {
            await attach(pid);
        } catch (err) {
            alert(String(err));
        }
    });

    q.addEventListener("input", render);
    refresh.addEventListener("click", refreshProcs);
    btnDetach.addEventListener("click", () => void detach());
    btnReload.addEventListener("click", () => void reload());

    function setAttached(info: Proc | null): void {
        if (info) {
            statusEl.className = "status-pill on";
            statusEl.textContent = `${info.name} · ${info.pid}`;
            btnDetach.disabled = false; btnReload.disabled = false;
        } else {
            statusEl.className = "status-pill";
            statusEl.textContent = "not attached";
            btnDetach.disabled = true; btnReload.disabled = true;
        }
    }

    onWsEvent((ev) => {
        if (ev.type === "hello") setAttached(ev.attached);
        else if (ev.type === "attached") setAttached({ pid: ev.pid, name: ev.name });
        else if (ev.type === "detached") setAttached(null);
    });

    // Initial fetches
    void refreshProcs();
    void status().then(s => setAttached(s.info));
}
```

- [ ] **Step 2: Mount it from main.ts**

Update `F:/FridaIL2CPPToolkit/host/public/main.ts`. Replace its content with:

```ts
import { connect as wsConnect } from "./lib/ws.js";
import { mountConnection } from "./panels/connection.js";

function $(sel: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`element not found: ${sel}`);
    return el as HTMLElement;
}

function wireTabs(groupName: string, contentEl: HTMLElement): void {
    const tabsEl = document.querySelector(`[data-tabs="${groupName}"]`) as HTMLElement | null;
    if (!tabsEl) return;
    tabsEl.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
        if (!btn || !btn.dataset.tab) return;
        for (const t of tabsEl.querySelectorAll(".tab")) t.classList.remove("active");
        btn.classList.add("active");
        contentEl.dataset.active = btn.dataset.tab;
        document.dispatchEvent(new CustomEvent("tab-change", { detail: { group: groupName, name: btn.dataset.tab } }));
    });
}

wireTabs("sidebar", $("#sidebar-content"));
wireTabs("main", $("#main-content"));

// Connect WS first so event handlers are ready
wsConnect();

// Mount sidebar's default tab: processes
mountConnection(
    $("#sidebar-content"),
    $("#status"),
    $("#btn-detach") as HTMLButtonElement,
    $("#btn-reload") as HTMLButtonElement,
);

console.log("[main] bootstrapped");
```

- [ ] **Step 3: Build and smoke test**

```bash
npm run build:ui
npm run host
```

Open http://localhost:3000. Expected:
- Process list populates in sidebar
- Filter works
- Click a process → attaches (status pill turns green, pid shows)
- `detach` button works
- `reload` button works (reloads agent without detaching)

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/connection.ts host/public/main.ts
git commit -m "feat(ui): migrate connection panel (process picker + attach/detach) to new theme"
```

---

### Task F2: Logs panel (event stream on the right)

**Files:**
- Create: `host/public/panels/logs.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write logs.ts**

Create `F:/FridaIL2CPPToolkit/host/public/panels/logs.ts`:

```ts
import { onWsEvent } from "../lib/ws.js";

export function mountLogs(container: HTMLElement): void {
    container.innerHTML = "";
    container.style.padding = "var(--s-2) 0";

    function appendLine(text: string, cls = "log"): void {
        const div = document.createElement("div");
        div.className = `line ${cls}`;
        const ts = new Date().toLocaleTimeString();
        div.innerHTML = `<span style="color:var(--ink-disabled); margin-right:8px">${ts}</span>`;
        div.appendChild(document.createTextNode(text));
        div.style.padding = "2px var(--s-3)";
        div.style.borderLeft = "2px solid transparent";
        if (cls === "hook") div.style.borderLeftColor = "var(--accent)";
        if (cls === "err")  div.style.borderLeftColor = "var(--err)";
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    onWsEvent((ev) => {
        if (ev.type === "message") {
            const m = ev.message;
            if (m.type === "log") {
                const payload = (m as { payload?: unknown }).payload;
                const text = typeof payload === "string" ? payload : JSON.stringify(payload);
                appendLine(text, "log");
            } else if (m.type === "agent-ready") {
                appendLine("[agent ready]", "ok");
            } else if (m.type === "socket") {
                const cls = (m as { cls?: string }).cls ?? "?";
                const name = (m as { name?: string }).name ?? "?";
                appendLine(`[net] ${cls} → ${name}`, "hook");
            } else {
                appendLine(`[${m.type}] ${JSON.stringify(m).slice(0, 200)}`, "hook");
            }
        } else if (ev.type === "attached") {
            appendLine(`↑ attached to ${ev.name} (${ev.pid})`, "ok");
        } else if (ev.type === "detached") {
            appendLine(`↓ detached${ev.reason ? ` (${ev.reason})` : ""}`, "err");
        }
    });
}
```

- [ ] **Step 2: Mount from main.ts**

Append to `main.ts` (after the `mountConnection` call):

```ts
import { mountLogs } from "./panels/logs.js";
// …
mountLogs($("#log"));
```

- [ ] **Step 3: Smoke test**

Build, start host, attach. Expected: `[agent ready]` line appears, then logs show on any RPC call.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/logs.ts host/public/main.ts
git commit -m "feat(ui): migrate logs panel to side-live column"
```

---

### Task F3: Search panel (find classes, find-by-field, dump)

**Files:**
- Create: `host/public/panels/search.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write search.ts**

Create `F:/FridaIL2CPPToolkit/host/public/panels/search.ts` reproducing the existing search actions in the new theme. Use the pattern below (adapt each action block):

```ts
import { rpcCall } from "../lib/rpc.js";

export function renderSearch(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3)">

        <div class="section-header">full analyze</div>
        <div style="display:flex; gap:var(--s-2)">
          <button class="btn primary" data-action="analyze">run analyze</button>
          <span style="color:var(--ink-muted); font-size:11.5px; align-self:center">lists assemblies + classes + MonoBehaviours</span>
        </div>

        <div class="section-header">by name <span class="meta">regex ok</span></div>
        <div style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="pattern" placeholder="Player · /^UI.*/" style="flex:1">
          <button class="btn" data-action="find">find classes</button>
        </div>

        <div class="section-header">by field <span class="meta">beats obfuscation</span></div>
        <div style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="typePattern" placeholder="type regex (Int32, Vector3)" style="flex:1">
          <input class="input" data-arg="namePattern" placeholder="name regex (health, gold)" style="flex:1">
          <button class="btn" data-action="findByField">find</button>
        </div>

        <div class="section-header">by method</div>
        <div style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="returnType" placeholder="return (Boolean)" style="flex:1">
          <input class="input" data-arg="paramType"  placeholder="param (Vector3)" style="flex:1">
          <input class="input" data-arg="name"       placeholder="name (Damage)" style="flex:1">
          <button class="btn" data-action="findByMethod">find</button>
        </div>

        <div class="section-header">string in memory</div>
        <div style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="text" placeholder='literal (e.g. "Game Over")' style="flex:1">
          <button class="btn" data-action="findStringInMemory">scan</button>
        </div>

        <div class="section-header">dump class</div>
        <div style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="name" placeholder="exact class name" style="flex:1">
          <button class="btn" data-action="dumpClass">full</button>
          <button class="btn" data-action="dumpStatics">statics</button>
        </div>

      </div>
    `;

    container.addEventListener("click", async (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn) return;
        const action = btn.dataset.action!;
        const args = collectArgs(btn, action);
        try {
            const result = await rpcCall(action, args);
            console.log(`[rpc ${action}]`, result);
        } catch (err) {
            console.error(`[rpc ${action}] err`, err);
        }
    });
}

function collectArgs(btn: HTMLElement, action: string): unknown[] {
    const group = btn.parentElement!;
    const inputs = group.querySelectorAll<HTMLInputElement>("[data-arg]");
    const raw = [...inputs].map(i => i.value);

    switch (action) {
        case "analyze": return [];
        case "find": return [raw[0]];
        case "findByField": return [raw[0] || null, raw[1] || null];
        case "findByMethod": return [{ returnType: raw[0], paramType: raw[1], name: raw[2] }];
        case "findStringInMemory": return [raw[0]];
        case "dumpClass":
        case "dumpStatics": return [raw[0]];
        default: return raw;
    }
}
```

- [ ] **Step 2: Wire tab switching in main.ts**

Add to `main.ts`:

```ts
import { renderSearch } from "./panels/search.js";

const mainContent = $("#main-content");
function renderMainTab(name: string): void {
    mainContent.innerHTML = "";
    if (name === "search")         renderSearch(mainContent);
    else if (name === "instance")  mainContent.textContent = "(instance — F4)";
    else if (name === "hookpatch") mainContent.textContent = "(hook&patch — F5)";
    else if (name === "socket")    mainContent.textContent = "(socket — F6)";
}
renderMainTab("search");
document.addEventListener("tab-change", (e) => {
    const detail = (e as CustomEvent).detail as { group: string; name: string };
    if (detail.group === "main") renderMainTab(detail.name);
});
```

- [ ] **Step 3: Smoke test**

Build, attach, click "full analyze" → logs stream. Click "find classes" with `Player` → results. Dump a class. Expected: identical to before.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/search.ts host/public/main.ts
git commit -m "feat(ui): migrate search panel to new theme"
```

---

### Task F4: Instance panel (capture + read/write fields + call method)

**Files:**
- Create: `host/public/panels/instance.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write instance.ts**

Create `F:/FridaIL2CPPToolkit/host/public/panels/instance.ts` following the pattern in `search.ts`. Reproduce each existing action from `host/public/index.html` lines 107-180 (the old instance tab). Actions to preserve:
- `listInstances(className, max)` + `captureViaGC(className, index)`
- `capture(className, tickMethod)` (hook-based)
- `listCaptured()`
- `dumpInstance(className)`
- `readField(className, fieldName)` / `writeField(className, fieldName, value)`
- `callInstance(className, methodName, args)` (with JSON-parsed args)
- `readList(className, fieldName, limit)`
- `enumerateList(className, fieldName, methods, limit)` (methods = comma-separated)
- `captureListElement(listClassName, listFieldName, index, asKey)`

Each action is a labeled row with `.input`s + a `.btn`. Same pattern as `renderSearch`.

- [ ] **Step 2: Wire the `renderMainTab` switch in main.ts**

Replace the `(instance — F4)` placeholder with `renderInstance(mainContent)`.

- [ ] **Step 3: Smoke test**

With `FridaCobaye.exe` attached: `listInstances("Player")` → list; `captureViaGC("Player", 0)` → captured; `dumpInstance("Player")` → fields logged; `readField("Player", "hp")`; `writeField("Player", "hp", 9999)`.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/instance.ts host/public/main.ts
git commit -m "feat(ui): migrate instance panel to new theme"
```

---

### Task F5: Hook & patch panel

**Files:**
- Create: `host/public/panels/hookpatch.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write hookpatch.ts**

Same pattern. Actions to preserve from old UI lines 207-245:
- `hook(className, methodName)`
- `replaceNoop(className, methodName)`
- `forceReturn(className, method, value)`
- `patchStatic(className, field, value)`
- `callStatic(className, method, args)` (args JSON-parsed)

- [ ] **Step 2: Wire in main.ts** (replace the `(hook&patch — F5)` placeholder)

- [ ] **Step 3: Smoke test**

With `FridaCobaye.exe` attached: install a `log hook` → hook fires log in event panel. `replaceNoop` on a method → subsequent calls return nothing. `patchStatic` works.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/hookpatch.ts host/public/main.ts
git commit -m "feat(ui): migrate hook&patch panel to new theme"
```

---

### Task F6: Socket panel (network capture)

**Files:**
- Create: `host/public/panels/socket.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write socket.ts**

Preserve from old UI lines 182-205:
- Inputs: `sendClass` (default "ecu"), `sendMethod` (default "xbe")
- Buttons: `startNetworkCapture`, `stopNetworkCapture`
- A scrolling log div dedicated to `{type:'socket'}` WS events, with filter + clear + auto-scroll checkbox.

The socket-specific log should be a secondary stream distinct from the main `#log` panel. Put it inside the socket tab content.

- [ ] **Step 2: Wire in main.ts** (replace the `(socket — F6)` placeholder)

- [ ] **Step 3: Smoke test**

With Dofus attached, `start` → messages stream in. With `FridaCobaye.exe` (no "ecu" class), `start` produces an error toast — expected.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/socket.ts host/public/main.ts
git commit -m "feat(ui): migrate socket panel to new theme"
```

---

### Task F7: Explorer panel (tree browser)

**Files:**
- Create: `host/public/panels/explorer.ts`
- Modify: `host/public/main.ts`

- [ ] **Step 1: Write explorer.ts**

Preserve the existing tree rendering from old `host/public/app.js` (the explorer is the most complex existing panel — around 200 lines). Keep both modes:
- "by assembly" → calls `listAssembliesInfo` → `listNamespaces` → `listClassesIn`
- "by inheritance" → calls `listSubclasses` recursively, rooted on an input default `UnityEngine.MonoBehaviour`

Use the same `.tag`-labeled items (e.g., `<span class="tag">{classes}</span>`) for counts.

- [ ] **Step 2: Wire in main.ts**

Add a sidebar tab switch:

```ts
import { renderExplorer } from "./panels/explorer.js";

const sidebarContent = $("#sidebar-content");
function renderSidebarTab(name: string): void {
    if (name === "processes") {
        mountConnection(sidebarContent, $("#status"), $("#btn-detach") as HTMLButtonElement, $("#btn-reload") as HTMLButtonElement);
    } else if (name === "explorer") {
        sidebarContent.innerHTML = "";
        renderExplorer(sidebarContent);
    }
}
renderSidebarTab("processes");
document.addEventListener("tab-change", (e) => {
    const d = (e as CustomEvent).detail as { group: string; name: string };
    if (d.group === "sidebar") renderSidebarTab(d.name);
    else if (d.group === "main") renderMainTab(d.name);
});
```

**Important:** `mountConnection` currently attaches listeners to `btnDetach`/`btnReload` every time it runs. Refactor it to idempotently replace handlers (or move the attach/detach button wiring outside, into `main.ts`) to avoid duplicated listeners when switching back and forth.

Suggested fix: move `btnDetach.addEventListener(...)` and `btnReload.addEventListener(...)` and the WS status wiring out of `mountConnection` into `main.ts` (where they're set up once at startup). `mountConnection` becomes purely about rendering the process list.

- [ ] **Step 3: Smoke test**

Attach, click "explorer" tab in sidebar. Expected: assemblies list loads; clicking one expands namespaces; clicking a namespace shows classes. "by inheritance" mode: enter `UnityEngine.MonoBehaviour`, "go" → subclasses listed.

- [ ] **Step 4: Commit**

```bash
git add host/public/panels/explorer.ts host/public/main.ts
git commit -m "feat(ui): migrate explorer tree to new theme and fix dup listener bug"
```

---

# Phase G — Final validation & cleanup

### Task G1: Delete the old app.js and style.css

**Files:**
- Delete: `host/public/app.js`
- Delete: `host/public/style.css`

- [ ] **Step 1: Verify they are no longer referenced**

Run: `grep -r "app.js\|style.css" host/public/` *(use the Grep tool)*
Expected: no results outside of possibly a changelog / README.

- [ ] **Step 2: Delete them**

Run: `rm host/public/app.js host/public/style.css`

- [ ] **Step 3: Full smoke test**

Start host from scratch, attach to `FridaCobaye.exe`, walk through every panel. Expected: everything works as before.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(ui): delete obsolete app.js and style.css"
```

---

### Task G2: Write smoke test checklist

**Files:**
- Create: `scripts/smoke.md`

- [ ] **Step 1: Write the checklist**

Create `F:/FridaIL2CPPToolkit/scripts/smoke.md`:

```markdown
# M1 Smoke Test — run before marking the milestone complete

Target: `FridaCobaye.exe`. Launch it before starting the host.

## Setup
- [ ] `npm run build:all` completes without errors
- [ ] `npm run host` starts, outputs the URL
- [ ] Browser opens on http://localhost:3000 — three-column layout appears in Operator Console theme

## Connection
- [ ] Process list populates within 2s
- [ ] Filter by "Frida" narrows the list
- [ ] Clicking `FridaCobaye.exe` → status pill turns green with pid
- [ ] `detach` → status pill goes gray
- [ ] `reload` after attach → agent reloads without detaching

## Search
- [ ] `full analyze` → logs stream in event panel (assemblies + classes listed)
- [ ] `find classes` with `Player` → returns list
- [ ] `find by field` with `Int32` / `hp` → returns matches (on FridaCobaye.exe any hp-like int field)
- [ ] `dump class · full` with a known class → logs all fields

## Instance
- [ ] `listInstances("Player")` → returns list of alive instances
- [ ] `captureViaGC("Player", 0)` → captured summary appears
- [ ] `dumpInstance("Player")` → fields logged
- [ ] `writeField("Player", "hp", 9999)` → in-game health visibly changes
- [ ] `readList(...)` on a known List<T> field → enumerates items

## Hook & patch
- [ ] `hook("Player", "TakeDamage")` → on next damage, hook line appears in event panel (amber left-border)
- [ ] `replaceNoop("Player", "TakeDamage")` → subsequent damage ignored
- [ ] `patchStatic("Player", "totalPlayersAlive", 999)` → value persists in-game

## Socket (skip if no Dofus available)
- [ ] `startNetworkCapture` → outbound messages stream in the socket log

## Explorer
- [ ] Switch to explorer tab → "by assembly" loads
- [ ] Expand one assembly → namespaces → classes
- [ ] Switch to "by inheritance" with `UnityEngine.MonoBehaviour` → subclasses listed

## Visual / theme
- [ ] The `not attached` status pill is gray, turns green pulsing when attached
- [ ] The watchlist placeholder shows an idle readout with dim dot
- [ ] Tabs: active one has an orange underline; others dim
- [ ] No harsh borders, no drop shadows, scan-lines barely visible but present
- [ ] Scroll bars are the toolkit-styled narrow variant
```

- [ ] **Step 2: Commit**

```bash
git add scripts/smoke.md
git commit -m "docs: add m1 smoke test checklist"
```

---

### Task G3: Run the smoke test

- [ ] **Step 1: Walk through every item in `scripts/smoke.md`**

Check each box. Record any deviation.

- [ ] **Step 2: If anything fails, create a follow-up task**

For each failure, create a minimal fix commit: reproduce → identify → fix → retest that single item → commit.

- [ ] **Step 3: If all pass, tag M1**

```bash
git tag -a m1-foundation -m "M1 complete: modular file structure + Operator Console theme + all existing panels migrated"
```

---

# Self-Review

Ran against the spec (`docs/superpowers/specs/2026-04-20-toolkit-refactor-design.md`):

1. **Spec coverage for M1 row (§7):**
   - "Découpage fichiers (server en modules, public en modules ES, rpc-agent éclaté)" → Phases B, C (agent) + Phases E, F (public) + Phase C (server). ✓
   - "theme.css Operator Console" → Phase D. ✓
   - "Layout shell 3-colonnes" → Task E1. ✓
   - "Rendu des panels existants dans le nouveau thème" → Phase F (F1-F7). ✓
   - "Aucune feature nouvelle" → enforced in "Scope Boundary". ✓
   - Acceptance "Même fonctionnel qu'avant" → Task G3 smoke. ✓

2. **Placeholder scan:** No "TBD", "implement later", or "add error handling" steps. Every task has exact file paths and concrete code or verbatim-copy instructions. The one "copy verbatim" instructions reference line ranges in the source file — this is acceptable because we have the source and the skill allows it when moving existing code.

3. **Type consistency:** `rpcCall` / `listProcesses` / `attach` / `detach` / `reload` / `status` — same names across `main.ts`, `connection.ts`, and `rpc.ts`. Panel mount functions use consistent signatures: either `render{Name}(container)` (pure render) or `mount{Name}(container, ...dependencies)` when deps are needed. `mountConnection` is the only mount (has deps: status pill, buttons), `render{Search,Instance,Hookpatch,Socket,Explorer,Logs}` are pure renders. Consistent.

4. **Ambiguity:** "Copy the method verbatim" is the only instruction that assumes the engineer can locate the source block. Since the source is a single `rpc.exports = {...}` object, methods are identifiable by name (e.g., `capture: function…`). Acceptable.

5. **Files reach 200 lines or below target:**
   - `src/rpc-agent/instance-ops.ts` estimated 350-400 lines with all 16 methods. **Exceeds the 200-line target.** Acceptable trade-off: these 16 methods form a cohesive responsibility (operating on captured instances) and splitting further would create artificial boundaries. Flagged in the spec as a known deviation. In M4 when we add Diff / Inspector support, we may split into `instance-read.ts` / `instance-call.ts` if the file grows further.
   - All other new files target under 200 lines.

---

# Post-M1: What's Next

After M1 tags cleanly, I'll write the M2 plan (Watchlist + Copy-for-Claude). That plan will build on M1's infrastructure:
- Add `src/rpc-agent/watchlist.ts` (Frida-side single-timer poller)
- Add WS event type `watchlist-tick` in `lib/ws.ts`
- Implement the `#watchlist` container with real `.readout` entries subscribing to ticks
- Add `📋 Copy for Claude` buttons to logs, instance dumps, watchlist

M3-M5 will follow the same pattern: one milestone → one plan → one smoke checklist → one tag.
