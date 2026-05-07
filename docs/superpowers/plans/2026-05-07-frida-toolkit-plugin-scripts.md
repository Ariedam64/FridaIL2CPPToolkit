# Plugin Scripts (v1.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a v1.4 plugin "Scripts" letting users define typed TS functions in `<profile>/plugins/scripts/*.ts` and invoke them manually from the web-app, composing instances/hooks/network ops via an injected `toolkit.*` API.

**Architecture:** `ScriptLoader` (chokidar + esbuild + `AsyncFunction` load with `defineScript` validation) feeds a registry consumed by `ScriptRunner`, which executes the user `run()` async with a typed `toolkit` proxy over existing per-session services (`InstanceRegistry`, `HookStore`, `FrameStore`, `agentCall`). HTTP routes expose list + run; WS streams logs and results. New page in the web-app lists scripts, generates a param form, runs, displays streaming logs.

**Tech Stack:** Node 20, TypeScript 5.5, esbuild (new dep), chokidar (new dep), vitest, Express, ws, vite/vanilla TS frontend.

**Spec:** [docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-scripts-design.md](../specs/2026-05-07-frida-toolkit-plugin-scripts-design.md)

**File map:**

| File | Created by Task | Role |
|---|---|---|
| `app/package.json` (modify) | T1 | Add `esbuild` + `chokidar` deps |
| `app/backend/core/scripts/types.ts` | T1 | All shared types |
| `app/backend/core/scripts/param-validator.ts` | T2 | `validateParamValues` |
| `app/backend/core/scripts/script-loader.ts` | T3, T4 | Compile + watch |
| `app/backend/core/scripts/toolkit-api.ts` | T5–T8 | Build injected `toolkit` |
| `app/backend/core/scripts/script-runner.ts` | T9, T10 | Run + timeout + source-map |
| `app/backend/core/scripts/types-emitter.ts` | T11 | Emit `.d.ts` + tsconfig |
| `app/backend/routes/scripts.ts` | T12 | HTTP routes |
| `app/backend/session.ts` (modify) | T13 | Wire into session lifecycle |
| `app/backend/ws-bridge.ts` (modify) | T13 | Forward script events |
| `app/frontend/pages/scripts.ts` | T14 | Scripts page UI |
| `app/test/backend/core/scripts/*.test.ts` | T1–T11 | Backend tests |
| `app/test/backend/routes/scripts.test.ts` | T12 | Route tests |
| `app/test/frontend/pages/scripts.test.ts` | T14 | Frontend tests |

---

## Task 1: Dependencies + types

**Files:**
- Modify: `app/package.json`
- Create: `app/backend/core/scripts/types.ts`
- Test: `app/test/backend/core/scripts/types.test.ts` (smoke: types compile)

- [ ] **Step 1: Add deps**

```bash
cd app && npm install --save esbuild@^0.24.0 chokidar@^4.0.0
```

Expected: `package.json` updated, `package-lock.json` regenerated, no errors.

- [ ] **Step 2: Create `types.ts`**

`app/backend/core/scripts/types.ts`:

```ts
// Plugin Scripts — shared types.
// Imported by script-loader, script-runner, toolkit-api, routes/scripts, and the frontend.

export type ParamSpec =
    | { type: "string";  label?: string; required?: boolean; default?: string;  placeholder?: string }
    | { type: "number";  label?: string; required?: boolean; default?: number;  min?: number; max?: number }
    | { type: "boolean"; label?: string; default?: boolean }
    | { type: "enum";    label?: string; values: readonly string[]; default?: string };

export type ParamSchema = Record<string, ParamSpec>;

export interface ScriptDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
    name: string;
    description?: string;
    params: { [K in keyof P]: ParamSpec };
    timeoutMs?: number;
    run: (args: P, toolkit: Toolkit) => Promise<unknown>;
}

export interface RegistryEntry {
    id: string;                 // = filename without .ts
    filePath: string;
    status: "loaded" | "compile-error" | "validation-error";
    definition?: Omit<ScriptDefinition, "run">;  // serializable subset for the API
    error?: string;
    loadedAt: string;           // ISO 8601
}

export interface RunResult {
    runId: string;
    scriptId: string;
    status: "ok" | "error" | "timeout";
    result?: unknown;
    error?: { message: string; stack?: string };
    startedAt: string;
    durationMs: number;
}

export interface ScriptLog {
    runId: string;
    level: "info" | "warn" | "error";
    args: unknown[];
    ts: string;
}

// ---------------------------------------------------------------------------
// Injected `toolkit` API surface
// ---------------------------------------------------------------------------

export type InstanceHandle = { className: string; handle: string; key: string };
export type HookHandle = { id: string };

export interface CaptureOpts { asKey?: string; index?: number }
export interface HookInstallOpts { mode?: "log" | "modify-return"; returnValue?: unknown }
export interface HookCallEvent { args: unknown[]; ts: string }

export interface NetworkPacket {
    id: string;
    direction: "in" | "out";
    messageType: string;
    payload: unknown;
    ts: number;
}

export interface Toolkit {
    instances: {
        find(label: string): Promise<InstanceHandle>;
        findAll(label: string): Promise<InstanceHandle[]>;
        capture(label: string, opts?: CaptureOpts): Promise<InstanceHandle>;
        read(handle: InstanceHandle, field: string): Promise<unknown>;
        write(handle: InstanceHandle, field: string, value: unknown): Promise<void>;
        call(handle: InstanceHandle, method: string, args?: unknown[]): Promise<unknown>;
        list(): Promise<InstanceHandle[]>;
    };
    hooks: {
        install(target: string, opts: HookInstallOpts): Promise<HookHandle>;
        remove(handle: HookHandle): Promise<void>;
        onceCall(target: string, opts?: { timeoutMs?: number }): Promise<HookCallEvent>;
    };
    network: {
        send(messageType: string, payload: Record<string, unknown>): Promise<void>;
        onceReceive(messageType: string, opts?: { timeoutMs?: number }): Promise<NetworkPacket>;
        recent(messageType?: string, limit?: number): Promise<NetworkPacket[]>;
    };
    log:   (...args: unknown[]) => void;
    warn:  (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    sleep: (ms: number) => Promise<void>;
}

// `defineScript` is an identity function with type inference for `params` → `args`.
export function defineScript<P extends Record<string, unknown>>(def: ScriptDefinition<P>): ScriptDefinition<P> {
    return def;
}
```

- [ ] **Step 3: Smoke test that types compile**

`app/test/backend/core/scripts/types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { defineScript } from "../../../../backend/core/scripts/types";

describe("types — defineScript", () => {
    it("returns the definition unchanged (identity function)", () => {
        const def = defineScript({
            name: "noop",
            params: {},
            run: async () => "ok",
        });
        expect(def.name).toBe("noop");
        expect(typeof def.run).toBe("function");
    });

    it("infers param types in run signature", async () => {
        const def = defineScript({
            name: "echo",
            params: { msg: { type: "string", required: true } },
            run: async ({ msg }) => msg.toUpperCase(),
        });
        const fakeToolkit = {} as Parameters<typeof def.run>[1];
        expect(await def.run({ msg: "hi" }, fakeToolkit)).toBe("HI");
    });
});
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/backend/core/scripts/types.test.ts
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add app/package.json app/package-lock.json app/backend/core/scripts/types.ts app/test/backend/core/scripts/types.test.ts
git commit -m "feat(scripts): add types + esbuild/chokidar deps"
```

---

## Task 2: Param validator

**Files:**
- Create: `app/backend/core/scripts/param-validator.ts`
- Test: `app/test/backend/core/scripts/param-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/param-validator.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { validateParamValues } from "../../../../backend/core/scripts/param-validator";
import type { ParamSchema } from "../../../../backend/core/scripts/types";

describe("validateParamValues", () => {
    const numSchema: ParamSchema = { mapId: { type: "number", required: true, min: 1, max: 1000 } };

    it("returns parsed values when valid", () => {
        const r = validateParamValues({ x: { type: "number", required: true } }, { x: 42 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.values).toEqual({ x: 42 });
    });

    it("rejects missing required param", () => {
        const r = validateParamValues(numSchema, {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/missing required param: mapId/);
    });

    it("rejects wrong type", () => {
        const r = validateParamValues(numSchema, { mapId: "abc" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*number/);
    });

    it("rejects number out of range (min)", () => {
        const r = validateParamValues(numSchema, { mapId: 0 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*min 1/);
    });

    it("rejects number out of range (max)", () => {
        const r = validateParamValues(numSchema, { mapId: 9999 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*max 1000/);
    });

    it("rejects enum value not in list", () => {
        const r = validateParamValues(
            { mode: { type: "enum", values: ["fast", "slow"] } },
            { mode: "medium" },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mode.*not in/);
    });

    it("rejects extra param not in schema", () => {
        const r = validateParamValues(numSchema, { mapId: 1, extra: true });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/unknown param: extra/);
    });

    it("applies defaults when value omitted", () => {
        const r = validateParamValues(
            { force: { type: "boolean", default: false } },
            {},
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.values).toEqual({ force: false });
    });

    it("accepts boolean true/false", () => {
        const r = validateParamValues({ b: { type: "boolean" } }, { b: true });
        expect(r.ok).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/param-validator.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `param-validator.ts`**

`app/backend/core/scripts/param-validator.ts`:

```ts
import type { ParamSchema, ParamSpec } from "./types";

export type ValidationResult =
    | { ok: true;  values: Record<string, unknown> }
    | { ok: false; error: string };

export function validateParamValues(
    schema: ParamSchema,
    raw: Record<string, unknown>,
): ValidationResult {
    const out: Record<string, unknown> = {};

    // Reject extra params not in schema (no silent extras).
    for (const k of Object.keys(raw)) {
        if (!(k in schema)) return { ok: false, error: `unknown param: ${k}` };
    }

    for (const [key, spec] of Object.entries(schema)) {
        const present = key in raw;
        const value = raw[key];

        if (!present || value === undefined || value === null) {
            if ("default" in spec && spec.default !== undefined) {
                out[key] = spec.default;
                continue;
            }
            if (spec.type !== "boolean" && (spec as { required?: boolean }).required) {
                return { ok: false, error: `missing required param: ${key}` };
            }
            continue;  // optional, no default → omit
        }

        const err = validateOne(key, spec, value);
        if (err) return { ok: false, error: err };
        out[key] = value;
    }

    return { ok: true, values: out };
}

function validateOne(key: string, spec: ParamSpec, value: unknown): string | null {
    switch (spec.type) {
        case "string":
            if (typeof value !== "string") return `${key} expected string, got ${typeof value}`;
            return null;
        case "number":
            if (typeof value !== "number" || !Number.isFinite(value)) {
                return `${key} expected number, got ${typeof value}`;
            }
            if (spec.min !== undefined && value < spec.min) return `${key} below min ${spec.min}`;
            if (spec.max !== undefined && value > spec.max) return `${key} above max ${spec.max}`;
            return null;
        case "boolean":
            if (typeof value !== "boolean") return `${key} expected boolean, got ${typeof value}`;
            return null;
        case "enum":
            if (typeof value !== "string" || !spec.values.includes(value)) {
                return `${key} value '${String(value)}' not in [${spec.values.join(", ")}]`;
            }
            return null;
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/backend/core/scripts/param-validator.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/param-validator.ts app/test/backend/core/scripts/param-validator.test.ts
git commit -m "feat(scripts): param-validator with type/range/enum/required checks"
```

---

## Task 3: ScriptLoader — compile + execute file

**Files:**
- Create: `app/backend/core/scripts/script-loader.ts` (initial, no chokidar yet)
- Test: `app/test/backend/core/scripts/script-loader-load.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/script-loader-load.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";

describe("ScriptLoader.loadFile", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-test-"));
        loader = new ScriptLoader(dir);
    });

    afterEach(() => {
        loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeScript(name: string, src: string): string {
        const p = path.join(dir, `${name}.ts`);
        fs.writeFileSync(p, src);
        return p;
    }

    it("loads a valid defineScript file → status 'loaded'", async () => {
        writeScript("hello", `
            import { defineScript } from "@toolkit/scripts";
            export default defineScript({
                name: "hello",
                params: { who: { type: "string", required: true } },
                run: async ({ who }) => "hi " + who,
            });
        `);
        const entry = await loader.loadFile(path.join(dir, "hello.ts"));
        expect(entry.status).toBe("loaded");
        expect(entry.definition?.name).toBe("hello");
        expect(entry.id).toBe("hello");
    });

    it("returns 'compile-error' on syntax error", async () => {
        writeScript("broken", `export default defineScript({{{{`);
        const entry = await loader.loadFile(path.join(dir, "broken.ts"));
        expect(entry.status).toBe("compile-error");
        expect(entry.error).toBeTruthy();
    });

    it("returns 'validation-error' when run is not async function", async () => {
        writeScript("badrun", `
            import { defineScript } from "@toolkit/scripts";
            export default { name: "badrun", params: {}, run: 42 };
        `);
        const entry = await loader.loadFile(path.join(dir, "badrun.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/run.*function/);
    });

    it("returns 'validation-error' when name is empty", async () => {
        writeScript("badname", `
            import { defineScript } from "@toolkit/scripts";
            export default defineScript({ name: "", params: {}, run: async () => null });
        `);
        const entry = await loader.loadFile(path.join(dir, "badname.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/name/);
    });

    it("blocks require() calls (not adversarial sandbox, defensive)", async () => {
        writeScript("evil", `
            const fs = require("fs");
            export default { name: "evil", params: {}, run: async () => null };
        `);
        const entry = await loader.loadFile(path.join(dir, "evil.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/require/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/script-loader-load.test.ts
```

Expected: ALL FAIL (file does not exist).

- [ ] **Step 3: Implement `script-loader.ts`**

`app/backend/core/scripts/script-loader.ts`:

```ts
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as esbuild from "esbuild";
import type { RegistryEntry, ScriptDefinition } from "./types";
import { defineScript } from "./types";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
    new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

export class ScriptLoader extends EventEmitter {
    private entries = new Map<string, RegistryEntry>();         // id → entry
    private definitions = new Map<string, ScriptDefinition>();  // id → live def (with run fn)

    constructor(private readonly dir: string) {
        super();
    }

    list(): RegistryEntry[] {
        return Array.from(this.entries.values());
    }

    get(id: string): RegistryEntry | null {
        return this.entries.get(id) ?? null;
    }

    /** Returns the live ScriptDefinition (with `run`) for execution. */
    getDefinition(id: string): ScriptDefinition | null {
        return this.definitions.get(id) ?? null;
    }

    async loadFile(filePath: string): Promise<RegistryEntry> {
        const id = path.basename(filePath, ".ts");
        const loadedAt = new Date().toISOString();

        let source: string;
        try {
            source = await fs.readFile(filePath, "utf8");
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: `read failed: ${(err as Error).message}`,
                loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        // 1. Compile TS → CJS JS with inline sourcemap.
        let compiled: { code: string };
        try {
            compiled = await esbuild.transform(source, {
                loader: "ts", format: "cjs", sourcemap: "inline",
                sourcefile: filePath, target: "es2022",
            });
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "compile-error",
                error: (err as Error).message, loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        // 2. Execute the JS in a curated context (no real sandbox; defensive only).
        const moduleObj = { exports: {} as Record<string, unknown> };
        const requireStub = (id: string): never => {
            throw new Error(`require('${id}') not allowed in scripts`);
        };

        try {
            const fn = new AsyncFunction("module", "exports", "require", "defineScript", compiled.code);
            await fn(moduleObj, moduleObj.exports, requireStub, defineScript);
        } catch (err) {
            const entry: RegistryEntry = {
                id, filePath, status: "validation-error",
                error: (err as Error).message, loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        // 3. Pull `default` export (from `export default …`) or fallback to module.exports.
        const candidate =
            (moduleObj.exports.default as ScriptDefinition | undefined)
            ?? (moduleObj.exports as unknown as ScriptDefinition);

        // 4. Validate shape.
        const validationError = validateShape(candidate);
        if (validationError) {
            const entry: RegistryEntry = {
                id, filePath, status: "validation-error",
                error: validationError, loadedAt,
            };
            this.entries.set(id, entry);
            this.definitions.delete(id);
            this.emit("change", entry);
            return entry;
        }

        const def = candidate as ScriptDefinition;
        this.definitions.set(id, def);
        const entry: RegistryEntry = {
            id, filePath, status: "loaded",
            definition: { name: def.name, description: def.description, params: def.params, timeoutMs: def.timeoutMs },
            loadedAt,
        };
        this.entries.set(id, entry);
        this.emit("change", entry);
        return entry;
    }

    /** Remove an entry (by id). Used on file unlink. */
    removeFile(filePath: string): void {
        const id = path.basename(filePath, ".ts");
        if (!this.entries.has(id)) return;
        this.entries.delete(id);
        this.definitions.delete(id);
        this.emit("remove", id);
    }

    dispose(): void {
        // Subclasses (T4) may override to stop chokidar.
        this.entries.clear();
        this.definitions.clear();
        this.removeAllListeners();
    }
}

function validateShape(d: unknown): string | null {
    if (!d || typeof d !== "object") return "default export missing or not an object";
    const def = d as Record<string, unknown>;
    if (typeof def.name !== "string" || def.name.length === 0) {
        return "name must be a non-empty string";
    }
    if (typeof def.params !== "object" || def.params === null) {
        return "params must be an object";
    }
    if (typeof def.run !== "function") return "run must be an async function";
    if (def.timeoutMs !== undefined) {
        if (typeof def.timeoutMs !== "number" || def.timeoutMs <= 0) {
            return "timeoutMs must be > 0";
        }
    }
    return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/backend/core/scripts/script-loader-load.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/script-loader.ts app/test/backend/core/scripts/script-loader-load.test.ts
git commit -m "feat(scripts): ScriptLoader.loadFile — esbuild + AsyncFunction + shape validation"
```

---

## Task 4: ScriptLoader — chokidar watch + duplicates + lifecycle

**Files:**
- Modify: `app/backend/core/scripts/script-loader.ts`
- Test: `app/test/backend/core/scripts/script-loader-watch.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/script-loader-watch.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VALID = (name: string) => `
    import { defineScript } from "@toolkit/scripts";
    export default defineScript({ name: "${name}", params: {}, run: async () => "${name}" });
`;

describe("ScriptLoader watch lifecycle", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-watch-"));
        loader = new ScriptLoader(dir);
        await loader.start();   // start chokidar
    });

    afterEach(() => {
        loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("loads files already present at start()", async () => {
        // First disposing the auto-started loader, then re-creating with pre-existing files.
        loader.dispose();
        fs.writeFileSync(path.join(dir, "preExisting.ts"), VALID("preExisting"));
        loader = new ScriptLoader(dir);
        await loader.start();
        expect(loader.list().map((e) => e.id)).toContain("preExisting");
    });

    it("adds new files on add event", async () => {
        const events: string[] = [];
        loader.on("change", (e) => events.push(`change:${e.id}`));

        fs.writeFileSync(path.join(dir, "added.ts"), VALID("added"));
        await sleep(300);  // chokidar debounce

        expect(loader.get("added")?.status).toBe("loaded");
        expect(events).toContain("change:added");
    });

    it("reloads on file change", async () => {
        fs.writeFileSync(path.join(dir, "v.ts"), VALID("v"));
        await sleep(300);
        const v1 = loader.get("v")?.loadedAt;

        await sleep(20);
        fs.writeFileSync(path.join(dir, "v.ts"), VALID("v")); // re-write
        await sleep(300);
        const v2 = loader.get("v")?.loadedAt;

        expect(v2).not.toBe(v1);
    });

    it("removes entry on unlink", async () => {
        fs.writeFileSync(path.join(dir, "gone.ts"), VALID("gone"));
        await sleep(300);
        expect(loader.get("gone")).not.toBeNull();

        fs.unlinkSync(path.join(dir, "gone.ts"));
        await sleep(300);
        expect(loader.get("gone")).toBeNull();
    });

    it("flags duplicate name across two files", async () => {
        fs.writeFileSync(path.join(dir, "first.ts"), VALID("dup"));
        await sleep(300);
        fs.writeFileSync(path.join(dir, "second.ts"), VALID("dup"));
        await sleep(300);

        const second = loader.get("second");
        expect(second?.status).toBe("validation-error");
        expect(second?.error).toMatch(/duplicate name 'dup'/);
    });

    it("ignores _types/ subdir and non-.ts files", async () => {
        fs.mkdirSync(path.join(dir, "_types"));
        fs.writeFileSync(path.join(dir, "_types", "junk.ts"), VALID("junk"));
        fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
        await sleep(300);

        expect(loader.get("junk")).toBeNull();
        expect(loader.get("notes")).toBeNull();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/script-loader-watch.test.ts
```

Expected: most fail (no `start()`, no chokidar wiring, no duplicate detection).

- [ ] **Step 3: Add `start()`, chokidar wiring, duplicate detection**

Modify `app/backend/core/scripts/script-loader.ts` — add chokidar import and these methods:

Add at top after `esbuild` import:

```ts
import chokidar, { type FSWatcher } from "chokidar";
```

Add a private field in the class:

```ts
    private watcher: FSWatcher | null = null;
```

Replace the `loadFile` body's "set entry" block to first detect duplicate names. Insert this block right BEFORE `this.entries.set(id, entry);` in the SUCCESS branch (status "loaded"):

```ts
        // Duplicate-name guard: another loaded entry with the same `name`?
        for (const existing of this.entries.values()) {
            if (existing.id === id) continue;
            if (existing.status === "loaded" && existing.definition?.name === def.name) {
                const dupEntry: RegistryEntry = {
                    id, filePath, status: "validation-error",
                    error: `duplicate name '${def.name}' (already used by ${existing.id})`,
                    loadedAt,
                };
                this.entries.set(id, dupEntry);
                this.definitions.delete(id);
                this.emit("change", dupEntry);
                return dupEntry;
            }
        }
```

Add new method `start()`:

```ts
    async start(): Promise<void> {
        if (this.watcher) return;
        // Ensure dir exists; chokidar throws on missing path with awaitWriteFinish.
        await fs.mkdir(this.dir, { recursive: true });

        // Glob: top-level *.ts only, ignore _types/ and dot-dirs.
        this.watcher = chokidar.watch(path.join(this.dir, "*.ts"), {
            ignoreInitial: false,
            depth: 0,
            awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
            ignored: (p: string) => path.basename(p).startsWith("_") || path.basename(p).startsWith("."),
        });

        this.watcher.on("add",    (p) => { void this.loadFile(p); });
        this.watcher.on("change", (p) => { void this.loadFile(p); });
        this.watcher.on("unlink", (p) => { this.removeFile(p); });

        // Wait until chokidar has emitted the initial scan.
        await new Promise<void>((resolve) => this.watcher!.once("ready", resolve));
    }
```

Replace `dispose()`:

```ts
    async dispose(): Promise<void> {
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
        this.entries.clear();
        this.definitions.clear();
        this.removeAllListeners();
    }
```

Note: callers in tests use `dispose()` without await — fine because `close()` resolves quickly and we don't depend on the result.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/backend/core/scripts/script-loader-watch.test.ts test/backend/core/scripts/script-loader-load.test.ts
```

Expected: all loader tests passing (5 + 6 = 11).

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/script-loader.ts app/test/backend/core/scripts/script-loader-watch.test.ts
git commit -m "feat(scripts): ScriptLoader.start — chokidar watch + duplicate-name guard"
```

---

## Task 5: Toolkit API — instances facet + label resolver

**Files:**
- Create: `app/backend/core/scripts/toolkit-api.ts` (initial scaffold + instances facet)
- Test: `app/test/backend/core/scripts/toolkit-api-instances.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/toolkit-api-instances.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";
import type { CapturedInstance } from "../../../../backend/core/instances/types";

function makeDeps(overrides?: Partial<ToolkitDeps>): ToolkitDeps {
    const captured: CapturedInstance[] = [];
    const registry = {
        list: () => captured,
        get: (k: string) => captured.find((c) => c.key === k) ?? null,
        set: vi.fn(),
        delete: vi.fn(),
    } as unknown as ToolkitDeps["instanceRegistry"];

    return {
        runId: "r1",
        instanceRegistry: registry,
        hookStore: null,
        frameStore: null,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l: string) => l,    // identity (no labels in tests)
        emitLog: vi.fn(),
        ...overrides,
    };
}

describe("toolkit.instances", () => {
    it("find resolves friendly label and returns single matching captured instance", async () => {
        const deps = makeDeps();
        (deps.instanceRegistry as { list: () => CapturedInstance[] }).list = () => [
            { key: "p", className: "PlayerManager", handle: "0xa", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
        ];
        deps.resolveLabel = (l) => l === "PlayerManager" ? "fzc" : l;
        // resolveLabel transforms friendly → obf, then registry filters by className === resolved
        // For this test, registry already has "PlayerManager" so we treat resolveLabel identity-ish.
        // The find logic compares against the className stored in the registry.

        const toolkit = buildToolkit(deps);
        const h = await toolkit.instances.find("PlayerManager");
        expect(h.className).toBe("PlayerManager");
        expect(h.handle).toBe("0xa");
    });

    it("find throws if no match", async () => {
        const toolkit = buildToolkit(makeDeps());
        await expect(toolkit.instances.find("Nope")).rejects.toThrow(/no captured instance.*Nope/);
    });

    it("find throws if N>1 match", async () => {
        const deps = makeDeps();
        (deps.instanceRegistry as { list: () => CapturedInstance[] }).list = () => [
            { key: "a", className: "X", handle: "0x1", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
            { key: "b", className: "X", handle: "0x2", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
        ];
        const toolkit = buildToolkit(deps);
        await expect(toolkit.instances.find("X")).rejects.toThrow(/2 matches/);
    });

    it("read calls agent with class+field+handle", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => 42) });
        const toolkit = buildToolkit(deps);
        const v = await toolkit.instances.read({ className: "C", handle: "0xa", key: "k" }, "kamas");
        expect(v).toBe(42);
        expect(deps.agentCall).toHaveBeenCalledWith("readField", ["C", "0xa", "kamas"]);
    });

    it("call calls agent with method + args", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => "ok") });
        const toolkit = buildToolkit(deps);
        const r = await toolkit.instances.call(
            { className: "C", handle: "0xa", key: "k" }, "TravelTo", [12345],
        );
        expect(r).toBe("ok");
        expect(deps.agentCall).toHaveBeenCalledWith("callMethod", ["C", "0xa", "TravelTo", [12345]]);
    });

    it("capture invokes agent + records into registry", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => "X@0xbeef") });
        const toolkit = buildToolkit(deps);
        const h = await toolkit.instances.capture("X");
        expect(h.className).toBe("X");
        expect(h.handle).toBe("0xbeef");
        expect((deps.instanceRegistry as { set: (...a: unknown[]) => void }).set).toHaveBeenCalled();
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-instances.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement initial `toolkit-api.ts` with instances facet**

`app/backend/core/scripts/toolkit-api.ts`:

```ts
import type { InstanceRegistry } from "../instances/instance-registry";
import type { HookStore } from "../hooks/hook-store";
import type { FrameStore } from "../network/frame-store";
import type {
    Toolkit, InstanceHandle, HookHandle, NetworkPacket, CaptureOpts,
    HookInstallOpts, HookCallEvent, ScriptLog,
} from "./types";

export interface ToolkitDeps {
    runId: string;
    instanceRegistry: InstanceRegistry | null;
    hookStore: HookStore | null;
    frameStore: FrameStore | null;
    agentCall: (method: string, args: unknown[]) => Promise<unknown>;
    resolveLabel: (friendly: string) => string;   // friendly → obf via LabelStore (or identity)
    emitLog: (log: Omit<ScriptLog, "runId" | "ts">) => void;
}

export function buildToolkit(deps: ToolkitDeps): Toolkit {
    return {
        instances: buildInstances(deps),
        hooks:     buildHooks(deps),      // T6
        network:   buildNetwork(deps),    // T7
        log:   (...args) => deps.emitLog({ level: "info",  args }),
        warn:  (...args) => deps.emitLog({ level: "warn",  args }),
        error: (...args) => deps.emitLog({ level: "error", args }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
}

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

function buildInstances(deps: ToolkitDeps): Toolkit["instances"] {
    const requireRegistry = () => {
        if (!deps.instanceRegistry) throw new Error("not attached: no instance registry");
        return deps.instanceRegistry;
    };

    const matchesLabel = (className: string, friendly: string): boolean => {
        return className === friendly || className === deps.resolveLabel(friendly);
    };

    return {
        async find(label) {
            const reg = requireRegistry();
            const matches = reg.list().filter((c) => matchesLabel(c.className, label));
            if (matches.length === 0) throw new Error(`no captured instance for label '${label}'`);
            if (matches.length > 1)  throw new Error(`label '${label}' has ${matches.length} matches; use findAll()`);
            const m = matches[0];
            return { className: m.className, handle: m.handle, key: m.key };
        },
        async findAll(label) {
            const reg = requireRegistry();
            return reg.list()
                .filter((c) => matchesLabel(c.className, label))
                .map((m): InstanceHandle => ({ className: m.className, handle: m.handle, key: m.key }));
        },
        async capture(label, opts) {
            const reg = requireRegistry();
            const className = deps.resolveLabel(label);
            const summary = await deps.agentCall("captureInstance", [
                className, opts?.index ?? 0, opts?.asKey ?? null,
            ]) as string;
            const m = summary.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
            if (!m) throw new Error(`capture returned unexpected format: ${summary}`);
            const [_, cls, handle] = m;
            const key = opts?.asKey ?? `${cls}@${handle}`;
            reg.set(key, cls, handle, "captureViaGC");
            return { className: cls, handle, key };
        },
        async read(handle, field) {
            return deps.agentCall("readField", [handle.className, handle.handle, field]);
        },
        async write(handle, field, value) {
            await deps.agentCall("writeField", [handle.className, handle.handle, field, value]);
        },
        async call(handle, method, args = []) {
            return deps.agentCall("callMethod", [handle.className, handle.handle, method, args]);
        },
        async list() {
            const reg = requireRegistry();
            return reg.list().map((m): InstanceHandle => ({
                className: m.className, handle: m.handle, key: m.key,
            }));
        },
    };
}

// Stubs for T6/T7 (filled in later tasks).
function buildHooks(deps: ToolkitDeps): Toolkit["hooks"] {
    return {
        async install() { throw new Error("hooks.install: not yet implemented (T6)"); },
        async remove() {  throw new Error("hooks.remove: not yet implemented (T6)"); },
        async onceCall() { throw new Error("hooks.onceCall: not yet implemented (T6)"); },
    };
}

function buildNetwork(deps: ToolkitDeps): Toolkit["network"] {
    return {
        async send() { throw new Error("network.send: not yet implemented (T7)"); },
        async onceReceive() { throw new Error("network.onceReceive: not yet implemented (T7)"); },
        async recent() { throw new Error("network.recent: not yet implemented (T7)"); },
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-instances.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/toolkit-api.ts app/test/backend/core/scripts/toolkit-api-instances.test.ts
git commit -m "feat(scripts): toolkit-api scaffold + instances facet (find/findAll/capture/read/write/call/list)"
```

---

## Task 6: Toolkit API — hooks facet

**Files:**
- Modify: `app/backend/core/scripts/toolkit-api.ts` (replace `buildHooks` stub)
- Test: `app/test/backend/core/scripts/toolkit-api-hooks.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/toolkit-api-hooks.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";

function makeDeps(): ToolkitDeps & { hookEmitter: EventEmitter } {
    const hookEmitter = new EventEmitter();
    const hookStore = {
        add: vi.fn((spec) => ({ id: "h1", spec, installedHookId: null, addedAt: 1 })),
        install: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        list: () => [],
        onAgentEvent: (listener: (evt: { hookId: string; args: unknown[] }) => void): (() => void) => {
            hookEmitter.on("event", listener);
            return () => hookEmitter.off("event", listener);
        },
    } as unknown as ToolkitDeps["hookStore"];

    return {
        runId: "r1",
        instanceRegistry: null,
        hookStore,
        frameStore: null,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l) => l,
        emitLog: vi.fn(),
        hookEmitter,
    } as ToolkitDeps & { hookEmitter: EventEmitter };
}

describe("toolkit.hooks", () => {
    it("install creates a hook spec and arms it", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        const h = await toolkit.hooks.install("PlayerManager.TakeDamage", { mode: "log" });
        expect(h.id).toBe("h1");
        expect((deps.hookStore as { add: (...a: unknown[]) => void }).add).toHaveBeenCalled();
        expect((deps.hookStore as { install: (...a: unknown[]) => void }).install).toHaveBeenCalledWith("h1");
    });

    it("remove uninstalls + deletes the hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await toolkit.hooks.remove({ id: "abc" });
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalledWith("abc");
    });

    it("onceCall installs hook + resolves on first event + removes hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);

        const promise = toolkit.hooks.onceCall("X.foo", { timeoutMs: 1000 });
        // Simulate an event arriving with the matching hookId.
        setTimeout(() => deps.hookEmitter.emit("event", { hookId: "h1", args: [42] }), 10);

        const evt = await promise;
        expect(evt.args).toEqual([42]);
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalledWith("h1");
    });

    it("onceCall rejects on timeout + removes hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await expect(toolkit.hooks.onceCall("X.never", { timeoutMs: 50 }))
            .rejects.toThrow(/timeout/);
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalled();
    });

    it("install throws when not attached (no hookStore)", async () => {
        const deps = { ...makeDeps(), hookStore: null };
        const toolkit = buildToolkit(deps);
        await expect(toolkit.hooks.install("X", {})).rejects.toThrow(/not attached/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-hooks.test.ts
```

Expected: ALL FAIL (current `buildHooks` is a stub, missing `onAgentEvent` on HookStore).

- [ ] **Step 3: Add `onAgentEvent` listener API to HookStore**

The script-side hooks need a way to subscribe to fired-hook events. Add to `app/backend/core/hooks/hook-store.ts` — append to the class:

```ts
    private agentEventListeners: Array<(evt: { hookId: string; args: unknown[] }) => void> = [];

    /** Subscribe to agent-emitted hook-call events. Used by toolkit-api.hooks.onceCall. */
    onAgentEvent(listener: (evt: { hookId: string; args: unknown[] }) => void): () => void {
        this.agentEventListeners.push(listener);
        return () => {
            const i = this.agentEventListeners.indexOf(listener);
            if (i >= 0) this.agentEventListeners.splice(i, 1);
        };
    }

    /** Called by session.ts when an `agent-message` of type `hook-event` arrives. */
    notifyAgentEvent(hookId: string, args: unknown[]): void {
        for (const l of this.agentEventListeners) {
            try { l({ hookId, args }); } catch { /* swallow */ }
        }
    }
```

Note: the existing session.ts already forwards `hook-event` via `agent-message`. We'll wire `notifyAgentEvent` into that path in T13. For now, the test simulates events via the listener directly.

- [ ] **Step 4: Replace `buildHooks` stub in `toolkit-api.ts`**

```ts
function buildHooks(deps: ToolkitDeps): Toolkit["hooks"] {
    const requireStore = () => {
        if (!deps.hookStore) throw new Error("not attached: no hook store");
        return deps.hookStore;
    };

    return {
        async install(target, opts) {
            const store = requireStore();
            const [className, methodName] = splitTarget(target);
            const spec = {
                className: deps.resolveLabel(className),
                methodName: deps.resolveLabel(methodName),
                mode: opts.mode ?? "log",
                returnValue: opts.returnValue,
            };
            const stored = store.add(spec as unknown as Parameters<typeof store.add>[0]);
            await store.install(stored.id);
            return { id: stored.id };
        },
        async remove(handle) {
            const store = requireStore();
            await store.remove(handle.id);
        },
        async onceCall(target, opts) {
            const store = requireStore();
            const [className, methodName] = splitTarget(target);
            const spec = {
                className: deps.resolveLabel(className),
                methodName: deps.resolveLabel(methodName),
                mode: "log",
            };
            const stored = store.add(spec as unknown as Parameters<typeof store.add>[0]);
            await store.install(stored.id);

            const timeoutMs = opts?.timeoutMs ?? 30_000;
            return new Promise<HookCallEvent>((resolve, reject) => {
                const timer = setTimeout(() => {
                    unsub();
                    void store.remove(stored.id);
                    reject(new Error(`timeout waiting for ${target} after ${timeoutMs}ms`));
                }, timeoutMs);

                const unsub = store.onAgentEvent((evt) => {
                    if (evt.hookId !== stored.id) return;
                    clearTimeout(timer);
                    unsub();
                    void store.remove(stored.id);
                    resolve({ args: evt.args, ts: new Date().toISOString() });
                });
            });
        },
    };
}

function splitTarget(target: string): [string, string] {
    const dot = target.lastIndexOf(".");
    if (dot < 0) throw new Error(`hook target must be 'Class.Method', got '${target}'`);
    return [target.slice(0, dot), target.slice(dot + 1)];
}
```

- [ ] **Step 5: Run tests**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-hooks.test.ts test/backend/core/hooks/
```

Expected: all hooks tests passing (5 + existing baseline).

- [ ] **Step 6: Commit**

```bash
git add app/backend/core/scripts/toolkit-api.ts app/backend/core/hooks/hook-store.ts app/test/backend/core/scripts/toolkit-api-hooks.test.ts
git commit -m "feat(scripts): toolkit.hooks (install/remove/onceCall) + HookStore.onAgentEvent"
```

---

## Task 7: Toolkit API — network facet

**Files:**
- Modify: `app/backend/core/scripts/toolkit-api.ts` (replace `buildNetwork` stub)
- Test: `app/test/backend/core/scripts/toolkit-api-network.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/toolkit-api-network.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { FrameStore } from "../../../../backend/core/network/frame-store";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";

function makeDeps(frameStore: FrameStore | null = null): ToolkitDeps {
    return {
        runId: "r1",
        instanceRegistry: null,
        hookStore: null,
        frameStore,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l) => l,
        emitLog: vi.fn(),
    };
}

describe("toolkit.network", () => {
    it("send delegates to agentCall('sendPacket', ...)", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await toolkit.network.send("Login", { user: "x" });
        expect(deps.agentCall).toHaveBeenCalledWith("sendPacket", ["Login", { user: "x" }]);
    });

    it("recent reads from FrameStore filtered by messageType", async () => {
        const fs = new FrameStore(10);
        fs.push({ direction: "in",  messageType: "A", payload: {}, ts: 1, typeKey: { kind: "named", name: "A" } as unknown });
        fs.push({ direction: "out", messageType: "B", payload: {}, ts: 2, typeKey: { kind: "named", name: "B" } as unknown });
        fs.push({ direction: "in",  messageType: "A", payload: {}, ts: 3, typeKey: { kind: "named", name: "A" } as unknown });

        const toolkit = buildToolkit(makeDeps(fs));
        const a = await toolkit.network.recent("A");
        expect(a).toHaveLength(2);
        expect(a.map((p) => p.messageType)).toEqual(["A", "A"]);
    });

    it("recent without filter returns all up to limit", async () => {
        const fs = new FrameStore(10);
        for (let i = 0; i < 5; i++) {
            fs.push({ direction: "in", messageType: `M${i}`, payload: {}, ts: i, typeKey: { kind: "named", name: `M${i}` } as unknown });
        }
        const toolkit = buildToolkit(makeDeps(fs));
        const r = await toolkit.network.recent(undefined, 3);
        expect(r).toHaveLength(3);
    });

    it("onceReceive resolves on next matching frame", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        const promise = toolkit.network.onceReceive("Hello");

        setTimeout(() => fs.push({
            direction: "in", messageType: "Hello", payload: { ok: true }, ts: 100,
            typeKey: { kind: "named", name: "Hello" } as unknown,
        }), 10);

        const pkt = await promise;
        expect(pkt.messageType).toBe("Hello");
    });

    it("onceReceive rejects on timeout", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        await expect(toolkit.network.onceReceive("Never", { timeoutMs: 50 }))
            .rejects.toThrow(/timeout/);
    });

    it("send throws if not attached (resolveLabel still ok but agentCall always fails)", async () => {
        const deps = { ...makeDeps(), agentCall: vi.fn(async () => { throw new Error("not attached"); }) };
        const toolkit = buildToolkit(deps);
        await expect(toolkit.network.send("X", {})).rejects.toThrow(/not attached/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-network.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `buildNetwork` (replace stub) in `toolkit-api.ts`**

Replace the stub `buildNetwork` with:

```ts
function buildNetwork(deps: ToolkitDeps): Toolkit["network"] {
    return {
        async send(messageType, payload) {
            await deps.agentCall("sendPacket", [messageType, payload]);
        },
        async onceReceive(messageType, opts) {
            if (!deps.frameStore) throw new Error("not attached: no frame store");
            const timeoutMs = opts?.timeoutMs ?? 30_000;
            return new Promise<NetworkPacket>((resolve, reject) => {
                const timer = setTimeout(() => {
                    deps.frameStore!.off("frame", listener);
                    reject(new Error(`timeout waiting for packet '${messageType}' after ${timeoutMs}ms`));
                }, timeoutMs);
                const listener = (frame: { id: string; direction: "in" | "out"; messageType: string; payload: unknown; ts: number }) => {
                    if (frame.messageType !== messageType) return;
                    clearTimeout(timer);
                    deps.frameStore!.off("frame", listener);
                    resolve({
                        id: frame.id, direction: frame.direction,
                        messageType: frame.messageType, payload: frame.payload, ts: frame.ts,
                    });
                };
                deps.frameStore!.on("frame", listener);
            });
        },
        async recent(messageType, limit) {
            if (!deps.frameStore) throw new Error("not attached: no frame store");
            const all = deps.frameStore.list({ limit: limit ?? 100 });
            const filtered = messageType ? all.filter((f) => f.messageType === messageType) : all;
            return filtered.map((f): NetworkPacket => ({
                id: f.id, direction: f.direction,
                messageType: f.messageType, payload: f.payload, ts: f.ts,
            }));
        },
    };
}
```

`FrameStore.push()` does not currently emit a `"frame"` event — add it. In `app/backend/core/network/frame-store.ts`, modify `push()` to emit before the existing `return frame;`:

```ts
        this.emit("frame", frame);
        return frame;
```

If existing code in the codebase (other plugins) listens for a different event name from FrameStore, leave that listener untouched and just add the new `"frame"` emit alongside.

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-network.test.ts test/backend/core/network/
```

Expected: 6 new passing + no regression on existing network tests.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/toolkit-api.ts app/backend/core/network/frame-store.ts app/test/backend/core/scripts/toolkit-api-network.test.ts
git commit -m "feat(scripts): toolkit.network (send/onceReceive/recent) + FrameStore frame event"
```

---

## Task 8: Toolkit API — utils smoke (log/sleep/buildToolkit factory)

The factory + log/sleep are already wired in T5. Just write a small validation test that exercises them.

**Files:**
- Test: `app/test/backend/core/scripts/toolkit-api-utils.test.ts`

- [ ] **Step 1: Write tests**

`app/test/backend/core/scripts/toolkit-api-utils.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildToolkit } from "../../../../backend/core/scripts/toolkit-api";

const baseDeps = () => ({
    runId: "r1",
    instanceRegistry: null,
    hookStore: null,
    frameStore: null,
    agentCall: vi.fn(async () => null),
    resolveLabel: (l: string) => l,
    emitLog: vi.fn(),
});

describe("toolkit utils", () => {
    it("log/warn/error emit logs with right level", () => {
        const deps = baseDeps();
        const toolkit = buildToolkit(deps);
        toolkit.log("hi", 42);
        toolkit.warn("warn");
        toolkit.error(new Error("oops"));
        expect(deps.emitLog).toHaveBeenCalledTimes(3);
        expect(deps.emitLog).toHaveBeenNthCalledWith(1, { level: "info",  args: ["hi", 42] });
        expect(deps.emitLog).toHaveBeenNthCalledWith(2, { level: "warn",  args: ["warn"] });
        expect(deps.emitLog.mock.calls[2][0].level).toBe("error");
    });

    it("sleep waits ~the given duration", async () => {
        const toolkit = buildToolkit(baseDeps());
        const t0 = Date.now();
        await toolkit.sleep(60);
        const dt = Date.now() - t0;
        expect(dt).toBeGreaterThanOrEqual(50);
    });
});
```

- [ ] **Step 2: Run tests**

```bash
cd app && npx vitest run test/backend/core/scripts/toolkit-api-utils.test.ts
```

Expected: 2 passing (no impl change needed — these were wired in T5).

- [ ] **Step 3: Commit**

```bash
git add app/test/backend/core/scripts/toolkit-api-utils.test.ts
git commit -m "test(scripts): toolkit utils (log/warn/error/sleep)"
```

---

## Task 9: ScriptRunner — run + timeout + concurrency

**Files:**
- Create: `app/backend/core/scripts/script-runner.ts`
- Test: `app/test/backend/core/scripts/script-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/script-runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScriptRunner } from "../../../../backend/core/scripts/script-runner";
import type { ScriptDefinition } from "../../../../backend/core/scripts/types";

const fakeLoader = (defs: Record<string, ScriptDefinition>) => ({
    getDefinition: (id: string) => defs[id] ?? null,
    get: (id: string) => (defs[id] ? { id, status: "loaded", definition: defs[id], filePath: "", loadedAt: "" } : null),
});

const fakeBuildToolkit = vi.fn((deps: { emitLog: (l: { level: string; args: unknown[] }) => void }) => ({
    instances: {} as never, hooks: {} as never, network: {} as never,
    log: (...args: unknown[]) => deps.emitLog({ level: "info", args }),
    warn: () => undefined, error: () => undefined, sleep: () => Promise.resolve(),
}));

describe("ScriptRunner", () => {
    let runner: ScriptRunner;
    let logs: unknown[];
    let results: unknown[];

    beforeEach(() => {
        logs = [];
        results = [];
        runner = new ScriptRunner(
            fakeLoader({}) as never,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            fakeBuildToolkit as never,
        );
        runner.on("log",    (l) => logs.push(l));
        runner.on("result", (r) => results.push(r));
    });

    it("runs a valid script and returns the result", async () => {
        const def: ScriptDefinition = {
            name: "echo", params: { msg: { type: "string", required: true } },
            run: async ({ msg }, tk) => { tk.log("got", msg); return `echo:${msg}`; },
        };
        runner = new ScriptRunner(
            fakeLoader({ echo: def }) as never,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            fakeBuildToolkit as never,
        );
        runner.on("log", (l) => logs.push(l));
        runner.on("result", (r) => results.push(r));

        const { runId } = await runner.start("echo", { msg: "hi" });
        await runner.waitFor(runId);

        expect((results[0] as { status: string }).status).toBe("ok");
        expect((results[0] as { result: unknown }).result).toBe("echo:hi");
        expect(logs.length).toBeGreaterThan(0);
    });

    it("rejects invalid params", async () => {
        const def: ScriptDefinition = {
            name: "x", params: { n: { type: "number", required: true } },
            run: async () => null,
        };
        runner = new ScriptRunner(fakeLoader({ x: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        await expect(runner.start("x", {})).rejects.toThrow(/missing required param: n/);
    });

    it("rejects unknown script id", async () => {
        await expect(runner.start("nope", {})).rejects.toThrow(/script not found/);
    });

    it("rejects same script twice concurrently", async () => {
        const def: ScriptDefinition = {
            name: "slow", params: {},
            run: async () => { await new Promise((r) => setTimeout(r, 50)); return "done"; },
        };
        runner = new ScriptRunner(fakeLoader({ slow: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        await runner.start("slow", {});
        await expect(runner.start("slow", {})).rejects.toThrow(/already running/);
    });

    it("respects timeoutMs", async () => {
        const def: ScriptDefinition = {
            name: "tic", params: {}, timeoutMs: 30,
            run: async () => { await new Promise((r) => setTimeout(r, 200)); return "late"; },
        };
        runner = new ScriptRunner(fakeLoader({ tic: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("tic", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string }).status).toBe("timeout");
    });

    it("captures error from script + status 'error'", async () => {
        const def: ScriptDefinition = {
            name: "boom", params: {},
            run: async () => { throw new Error("kaboom"); },
        };
        runner = new ScriptRunner(fakeLoader({ boom: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("boom", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string; error?: { message: string } }).status).toBe("error");
        expect((results[0] as { error?: { message: string } }).error?.message).toMatch(/kaboom/);
    });

    it("rejects non-serializable result", async () => {
        const def: ScriptDefinition = {
            name: "cycle", params: {},
            run: async () => { const o: Record<string, unknown> = {}; o.self = o; return o; },
        };
        runner = new ScriptRunner(fakeLoader({ cycle: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("cycle", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string; error?: { message: string } }).status).toBe("error");
        expect((results[0] as { error?: { message: string } }).error?.message).toMatch(/not serializable/);
    });

    it("allows two different scripts to run in parallel", async () => {
        const a: ScriptDefinition = { name: "a", params: {}, run: async () => { await new Promise((r) => setTimeout(r, 30)); return "a"; } };
        const b: ScriptDefinition = { name: "b", params: {}, run: async () => "b" };
        runner = new ScriptRunner(fakeLoader({ a, b }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId: ra } = await runner.start("a", {});
        const { runId: rb } = await runner.start("b", {});
        await Promise.all([runner.waitFor(ra), runner.waitFor(rb)]);
        expect(results).toHaveLength(2);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/script-runner.test.ts
```

Expected: ALL FAIL (file doesn't exist).

- [ ] **Step 3: Implement `script-runner.ts`**

`app/backend/core/scripts/script-runner.ts`:

```ts
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { validateParamValues } from "./param-validator";
import type { ScriptLoader } from "./script-loader";
import type { Toolkit, RunResult, ScriptLog, ScriptDefinition } from "./types";
import type { ToolkitDeps } from "./toolkit-api";

interface RunnerDeps {
    instanceRegistry: ToolkitDeps["instanceRegistry"];
    hookStore: ToolkitDeps["hookStore"];
    frameStore: ToolkitDeps["frameStore"];
    agentCall: ToolkitDeps["agentCall"];
    resolveLabel: ToolkitDeps["resolveLabel"];
}

type BuildToolkit = (deps: ToolkitDeps) => Toolkit;

const DEFAULT_TIMEOUT_MS = 30_000;

export class ScriptRunner extends EventEmitter {
    private running = new Map<string, string>();   // scriptId → runId currently running
    private waiters = new Map<string, Promise<void>>();  // runId → promise

    constructor(
        private readonly loader: Pick<ScriptLoader, "getDefinition" | "get">,
        private readonly deps: RunnerDeps,
        private readonly buildToolkit: BuildToolkit,
    ) {
        super();
    }

    /** Resolves the runId once the script has STARTED (not finished). */
    async start(scriptId: string, paramValues: Record<string, unknown>): Promise<{ runId: string }> {
        const def = this.loader.getDefinition(scriptId);
        if (!def) throw new Error(`script not found: ${scriptId}`);

        const validated = validateParamValues(def.params, paramValues);
        if (!validated.ok) throw new Error(validated.error);

        if (this.running.has(scriptId)) {
            throw new Error(`script '${scriptId}' is already running`);
        }

        const runId = randomUUID();
        this.running.set(scriptId, runId);

        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        const done = (async () => {
            const emitLog = (log: Omit<ScriptLog, "runId" | "ts">): void => {
                const event: ScriptLog = { ...log, runId, ts: new Date().toISOString() };
                this.emit("log", event);
            };

            const toolkit = this.buildToolkit({ ...this.deps, runId, emitLog });

            const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
                timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
            });

            let result: RunResult;
            try {
                const winner = await Promise.race([
                    def.run(validated.values, toolkit),
                    timeoutPromise,
                ]);
                if (timer) clearTimeout(timer);

                if (winner === TIMEOUT_SENTINEL) {
                    result = { runId, scriptId, status: "timeout", startedAt, durationMs: Date.now() - t0 };
                } else {
                    try {
                        const serialized = JSON.parse(JSON.stringify(winner ?? null));
                        result = { runId, scriptId, status: "ok", result: serialized, startedAt, durationMs: Date.now() - t0 };
                    } catch (err) {
                        result = {
                            runId, scriptId, status: "error",
                            error: { message: `result not serializable: ${(err as Error).message}` },
                            startedAt, durationMs: Date.now() - t0,
                        };
                    }
                }
            } catch (err) {
                if (timer) clearTimeout(timer);
                const e = err as Error;
                result = {
                    runId, scriptId, status: "error",
                    error: { message: e.message, stack: e.stack },
                    startedAt, durationMs: Date.now() - t0,
                };
            } finally {
                this.running.delete(scriptId);
                this.waiters.delete(runId);
            }

            this.emit("result", result);
        })();

        this.waiters.set(runId, done);
        return { runId };
    }

    /** Wait until a specific run has completed (resolved or errored). */
    waitFor(runId: string): Promise<void> {
        return this.waiters.get(runId) ?? Promise.resolve();
    }

    isRunning(scriptId: string): boolean {
        return this.running.has(scriptId);
    }
}

const TIMEOUT_SENTINEL = Symbol("timeout");
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/backend/core/scripts/script-runner.test.ts
```

Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/script-runner.ts app/test/backend/core/scripts/script-runner.test.ts
git commit -m "feat(scripts): ScriptRunner — start/timeout/concurrency/serialization"
```

---

## Task 10: ScriptRunner — source-map error remapping

The runner currently returns the JS-transpiled stack on error. We need to re-map it to point to the user's `.ts` source via the inline sourcemap stored in the compiled JS by esbuild.

**Files:**
- Modify: `app/backend/core/scripts/script-loader.ts` (expose compiled JS + sourcemap per script)
- Modify: `app/backend/core/scripts/script-runner.ts` (apply remapping on error)
- Test: `app/test/backend/core/scripts/script-runner-sourcemap.test.ts`

- [ ] **Step 1: Add `source-map-support` style remapping deps**

```bash
cd app && npm install --save source-map@^0.7.4
```

- [ ] **Step 2: Expose compiled JS from ScriptLoader**

In `app/backend/core/scripts/script-loader.ts`, add a private map and expose a getter:

```ts
    private compiledByid = new Map<string, string>();   // id → compiled JS (with inline sourcemap)

    getCompiled(id: string): string | null {
        return this.compiledByid.get(id) ?? null;
    }
```

In `loadFile`, after `compiled = await esbuild.transform(...)` succeeds, store it:

```ts
        this.compiledByid.set(id, compiled.code);
```

In `removeFile` and `dispose`, also clear `compiledByid`.

- [ ] **Step 3: Write the failing test**

`app/test/backend/core/scripts/script-runner-sourcemap.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";
import { ScriptRunner } from "../../../../backend/core/scripts/script-runner";
import { buildToolkit } from "../../../../backend/core/scripts/toolkit-api";

describe("ScriptRunner — source-map remapping", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-sm-"));
        loader = new ScriptLoader(dir);
    });

    afterEach(async () => {
        await loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("error stack points to user .ts line, not JS line", async () => {
        const filePath = path.join(dir, "boom.ts");
        // 5 leading lines + throw on line 6
        fs.writeFileSync(filePath, [
            "import { defineScript } from '@toolkit/scripts';",
            "export default defineScript({",
            "    name: 'boom', params: {},",
            "    run: async () => {",
            "        const x = 1;",
            "        throw new Error('explode');",
            "    },",
            "});",
        ].join("\n"));

        await loader.loadFile(filePath);
        const runner = new ScriptRunner(
            loader,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            buildToolkit,
        );
        const results: unknown[] = [];
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("boom", {});
        await runner.waitFor(runId);

        const r = results[0] as { status: string; error: { message: string; stack?: string } };
        expect(r.status).toBe("error");
        expect(r.error.stack).toMatch(/boom\.ts:6/);  // line of `throw`
    });
});
```

- [ ] **Step 4: Run test to verify it fails**

```bash
cd app && npx vitest run test/backend/core/scripts/script-runner-sourcemap.test.ts
```

Expected: FAIL — stack mentions JS lines, not `boom.ts:6`.

- [ ] **Step 5: Implement source-map remapping in ScriptRunner**

Add to `script-runner.ts` top imports:

```ts
import { SourceMapConsumer } from "source-map";
```

Add helper at the bottom of the file:

```ts
/** Parse `//# sourceMappingURL=data:application/json;base64,<...>` from compiled JS. */
function extractInlineSourceMap(js: string): string | null {
    const m = js.match(/\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/);
    if (!m) return null;
    try {
        return Buffer.from(m[1], "base64").toString("utf8");
    } catch {
        return null;
    }
}

/** Re-map each `at … (eval at …, <anonymous>:LINE:COL)` line to the original .ts source. */
async function remapStack(stack: string, compiledJs: string, originalPath: string): Promise<string> {
    const rawMap = extractInlineSourceMap(compiledJs);
    if (!rawMap) return stack;
    const consumer = await new SourceMapConsumer(rawMap);
    try {
        return stack.split("\n").map((line) => {
            // Patterns we typically see for AsyncFunction stacks:
            //   "    at <anonymous>:LINE:COL"
            //   "    at run (<anonymous>:LINE:COL)"
            const m = line.match(/<anonymous>:(\d+):(\d+)/);
            if (!m) return line;
            const lineNo = parseInt(m[1], 10);
            const colNo  = parseInt(m[2], 10);
            const orig = consumer.originalPositionFor({ line: lineNo, column: colNo });
            if (orig.source && orig.line) {
                return line.replace(/<anonymous>:\d+:\d+/, `${path.basename(originalPath)}:${orig.line}:${orig.column}`);
            }
            return line;
        }).join("\n");
    } finally {
        consumer.destroy();
    }
}
```

Add `import * as path from "node:path";` to top.

In the `start` method, change the error block to remap. Replace:

```ts
            } catch (err) {
                if (timer) clearTimeout(timer);
                const e = err as Error;
                result = {
                    runId, scriptId, status: "error",
                    error: { message: e.message, stack: e.stack },
                    startedAt, durationMs: Date.now() - t0,
                };
            }
```

with:

```ts
            } catch (err) {
                if (timer) clearTimeout(timer);
                const e = err as Error;
                let stack = e.stack;
                const compiled = (this.loader as { getCompiled?: (id: string) => string | null }).getCompiled?.(scriptId);
                const entry = this.loader.get(scriptId);
                if (stack && compiled && entry?.filePath) {
                    try { stack = await remapStack(stack, compiled, entry.filePath); }
                    catch { /* fall back to raw stack */ }
                }
                result = {
                    runId, scriptId, status: "error",
                    error: { message: e.message, stack },
                    startedAt, durationMs: Date.now() - t0,
                };
            }
```

- [ ] **Step 6: Run tests to verify pass**

```bash
cd app && npx vitest run test/backend/core/scripts/
```

Expected: all scripts tests passing (including new source-map test).

- [ ] **Step 7: Commit**

```bash
git add app/backend/core/scripts/script-loader.ts app/backend/core/scripts/script-runner.ts app/test/backend/core/scripts/script-runner-sourcemap.test.ts app/package.json app/package-lock.json
git commit -m "feat(scripts): re-map error stack-traces to user .ts source via inline sourcemap"
```

---

## Task 11: types-emitter — generate .d.ts + tsconfig

**Files:**
- Create: `app/backend/core/scripts/types-emitter.ts`
- Test: `app/test/backend/core/scripts/types-emitter.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/core/scripts/types-emitter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emitScriptsTypes } from "../../../../backend/core/scripts/types-emitter";

describe("emitScriptsTypes", () => {
    let dir: string;

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-emit-")); });
    afterEach(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("creates _types/toolkit.d.ts with required exports", () => {
        emitScriptsTypes(dir);
        const dts = fs.readFileSync(path.join(dir, "_types", "toolkit.d.ts"), "utf8");
        expect(dts).toMatch(/export\s+function\s+defineScript/);
        expect(dts).toMatch(/export\s+interface\s+Toolkit/);
        expect(dts).toMatch(/export\s+type\s+ParamSpec/);
    });

    it("creates tsconfig.json with paths mapping for @toolkit/scripts", () => {
        emitScriptsTypes(dir);
        const tsconfig = JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8"));
        expect(tsconfig.compilerOptions.paths["@toolkit/scripts"][0]).toMatch(/_types\/toolkit\.d\.ts/);
        expect(tsconfig.exclude).toContain("_types/**");
    });

    it("is idempotent (overwrites without error)", () => {
        emitScriptsTypes(dir);
        emitScriptsTypes(dir);
        expect(fs.existsSync(path.join(dir, "_types", "toolkit.d.ts"))).toBe(true);
    });

    it("creates dirs if missing", () => {
        const sub = path.join(dir, "nested", "scripts");
        emitScriptsTypes(sub);
        expect(fs.existsSync(path.join(sub, "_types", "toolkit.d.ts"))).toBe(true);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/core/scripts/types-emitter.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `types-emitter.ts`**

`app/backend/core/scripts/types-emitter.ts`:

```ts
import * as fs from "node:fs";
import * as path from "node:path";

const DTS_CONTENT = `// AUTO-GENERATED by frida-il2cpp-toolkit. Do not edit by hand.

declare module "@toolkit/scripts" {
    export type ParamSpec =
        | { type: "string";  label?: string; required?: boolean; default?: string;  placeholder?: string }
        | { type: "number";  label?: string; required?: boolean; default?: number;  min?: number; max?: number }
        | { type: "boolean"; label?: string; default?: boolean }
        | { type: "enum";    label?: string; values: readonly string[]; default?: string };

    export type ParamSchema = Record<string, ParamSpec>;

    export interface ScriptDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
        name: string;
        description?: string;
        params: { [K in keyof P]: ParamSpec };
        timeoutMs?: number;
        run: (args: P, toolkit: Toolkit) => Promise<unknown>;
    }

    export type InstanceHandle = { className: string; handle: string; key: string };
    export type HookHandle = { id: string };

    export interface CaptureOpts { asKey?: string; index?: number }
    export interface HookInstallOpts { mode?: "log" | "modify-return"; returnValue?: unknown }
    export interface HookCallEvent { args: unknown[]; ts: string }
    export interface NetworkPacket {
        id: string; direction: "in" | "out"; messageType: string; payload: unknown; ts: number;
    }

    export interface Toolkit {
        instances: {
            find(label: string): Promise<InstanceHandle>;
            findAll(label: string): Promise<InstanceHandle[]>;
            capture(label: string, opts?: CaptureOpts): Promise<InstanceHandle>;
            read(handle: InstanceHandle, field: string): Promise<unknown>;
            write(handle: InstanceHandle, field: string, value: unknown): Promise<void>;
            call(handle: InstanceHandle, method: string, args?: unknown[]): Promise<unknown>;
            list(): Promise<InstanceHandle[]>;
        };
        hooks: {
            install(target: string, opts: HookInstallOpts): Promise<HookHandle>;
            remove(handle: HookHandle): Promise<void>;
            onceCall(target: string, opts?: { timeoutMs?: number }): Promise<HookCallEvent>;
        };
        network: {
            send(messageType: string, payload: Record<string, unknown>): Promise<void>;
            onceReceive(messageType: string, opts?: { timeoutMs?: number }): Promise<NetworkPacket>;
            recent(messageType?: string, limit?: number): Promise<NetworkPacket[]>;
        };
        log:   (...args: unknown[]) => void;
        warn:  (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        sleep: (ms: number) => Promise<void>;
    }

    export function defineScript<P extends Record<string, unknown>>(def: ScriptDefinition<P>): ScriptDefinition<P>;
}
`;

const TSCONFIG = {
    compilerOptions: {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "node",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        paths: { "@toolkit/scripts": ["./_types/toolkit.d.ts"] },
    },
    include: ["**/*.ts"],
    exclude: ["_types/**", "node_modules/**"],
};

export function emitScriptsTypes(scriptsDir: string): void {
    fs.mkdirSync(path.join(scriptsDir, "_types"), { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, "_types", "toolkit.d.ts"), DTS_CONTENT, "utf8");
    fs.writeFileSync(path.join(scriptsDir, "tsconfig.json"), JSON.stringify(TSCONFIG, null, 2), "utf8");
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd app && npx vitest run test/backend/core/scripts/types-emitter.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/scripts/types-emitter.ts app/test/backend/core/scripts/types-emitter.test.ts
git commit -m "feat(scripts): emit toolkit.d.ts + tsconfig.json for VSCode autocomplete"
```

---

## Task 12: HTTP routes — GET /scripts + POST /:id/run

**Files:**
- Create: `app/backend/routes/scripts.ts`
- Test: `app/test/backend/routes/scripts.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/backend/routes/scripts.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { mountScripts, type ScriptsDeps } from "../../../backend/routes/scripts";
import type { ScriptDefinition, RegistryEntry } from "../../../backend/core/scripts/types";

const fakeDef = (id: string): ScriptDefinition => ({
    name: id, params: { x: { type: "number", required: true } },
    run: async ({ x }) => `got ${x}`,
});

function makeApp(opts: { running?: boolean; entries?: RegistryEntry[] } = {}) {
    const entries: RegistryEntry[] = opts.entries ?? [
        { id: "echo", filePath: "/p/echo.ts", status: "loaded", definition: { name: "echo", params: { x: { type: "number", required: true } } }, loadedAt: "2026-05-07T00:00:00Z" },
        { id: "broken", filePath: "/p/broken.ts", status: "compile-error", error: "boom", loadedAt: "2026-05-07T00:00:01Z" },
    ];

    const deps: ScriptsDeps = {
        loader: () => ({ list: () => entries, get: (id: string) => entries.find((e) => e.id === id) ?? null, getDefinition: (id: string) => id === "echo" ? fakeDef("echo") : null }) as never,
        runner: () => ({
            start: vi.fn(async (scriptId: string, params: Record<string, unknown>) => ({ runId: "run-1" })),
            isRunning: () => opts.running ?? false,
        }) as never,
    };

    const app = express();
    app.use(express.json());
    mountScripts(app, deps);
    return { app, deps };
}

describe("routes/scripts", () => {
    it("GET /api/scripts returns registry without `run`", async () => {
        const { app } = makeApp();
        const r = await request(app).get("/api/scripts");
        expect(r.status).toBe(200);
        expect(r.body.scripts).toHaveLength(2);
        expect(r.body.scripts[0].definition).not.toHaveProperty("run");
    });

    it("POST /api/scripts/:id/run returns runId", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/echo/run").send({ params: { x: 42 } });
        expect(r.status).toBe(200);
        expect(r.body.runId).toBe("run-1");
    });

    it("POST /api/scripts/:id/run rejects unknown script with 404", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/nope/run").send({ params: {} });
        expect(r.status).toBe(404);
    });

    it("POST /api/scripts/:id/run rejects compile-error script with 422", async () => {
        const { app } = makeApp();
        const r = await request(app).post("/api/scripts/broken/run").send({ params: {} });
        expect(r.status).toBe(422);
    });

    it("POST /api/scripts/:id/run rejects already-running with 409", async () => {
        const { app } = makeApp({ running: true });
        const r = await request(app).post("/api/scripts/echo/run").send({ params: { x: 1 } });
        expect(r.status).toBe(409);
    });

    it("POST /api/scripts/:id/run rejects bad params with 400", async () => {
        const { app, deps } = makeApp();
        // The runner.start throws on invalid params per Task 9
        deps.runner = () => ({
            start: async () => { throw new Error("missing required param: x"); },
            isRunning: () => false,
        }) as never;
        const r = await request(app).post("/api/scripts/echo/run").send({ params: {} });
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/missing required param: x/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/backend/routes/scripts.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `routes/scripts.ts`**

`app/backend/routes/scripts.ts`:

```ts
import type { Express } from "express";
import type { ScriptLoader } from "../core/scripts/script-loader";
import type { ScriptRunner } from "../core/scripts/script-runner";

export interface ScriptsDeps {
    loader: () => Pick<ScriptLoader, "list" | "get" | "getDefinition"> | null;
    runner: () => Pick<ScriptRunner, "start" | "isRunning"> | null;
}

export function mountScripts(app: Express, deps: ScriptsDeps): void {
    app.get("/api/scripts", (_req, res) => {
        const loader = deps.loader();
        if (!loader) { res.json({ scripts: [] }); return; }
        // The registry entries already exclude `run` (only the serializable subset is in `definition`).
        res.json({ scripts: loader.list() });
    });

    app.post("/api/scripts/:id/run", async (req, res) => {
        const loader = deps.loader();
        const runner = deps.runner();
        if (!loader || !runner) { res.status(503).json({ error: "not attached" }); return; }

        const id = req.params.id;
        const entry = loader.get(id);
        if (!entry) { res.status(404).json({ error: `script not found: ${id}` }); return; }
        if (entry.status !== "loaded") {
            res.status(422).json({ error: `script in ${entry.status} state: ${entry.error ?? ""}` });
            return;
        }
        if (runner.isRunning(id)) {
            res.status(409).json({ error: `script '${id}' already running` });
            return;
        }

        const params = (req.body?.params ?? {}) as Record<string, unknown>;
        try {
            const { runId } = await runner.start(id, params);
            res.json({ runId });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Validation errors → 400; everything else → 500
            const status =
                /missing required|expected|min |max |unknown param|not in/.test(msg) ? 400 : 500;
            res.status(status).json({ error: msg });
        }
    });
}
```

- [ ] **Step 4: Run tests**

```bash
cd app && npx vitest run test/backend/routes/scripts.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add app/backend/routes/scripts.ts app/test/backend/routes/scripts.test.ts
git commit -m "feat(scripts): HTTP routes — GET /api/scripts, POST /:id/run"
```

---

## Task 13: Wire into session.ts + ws-bridge.ts

**Files:**
- Modify: `app/backend/session.ts`
- Modify: `app/backend/ws-bridge.ts`
- Modify: `app/backend/server.ts` (mount the route)

- [ ] **Step 1: Add ScriptLoader + ScriptRunner to Session**

In `app/backend/session.ts`:

Add imports at top:

```ts
import { ScriptLoader } from "./core/scripts/script-loader.js";
import { ScriptRunner } from "./core/scripts/script-runner.js";
import { buildToolkit } from "./core/scripts/toolkit-api.js";
import { emitScriptsTypes } from "./core/scripts/types-emitter.js";
```

Add private fields in the class:

```ts
    private currentScriptLoader: ScriptLoader | null = null;
    private currentScriptRunner: ScriptRunner | null = null;
```

Add public getters near other getters (search for `instanceRegistry()` style getter patterns):

```ts
    scriptLoader(): ScriptLoader | null { return this.currentScriptLoader; }
    scriptRunner(): ScriptRunner | null { return this.currentScriptRunner; }
```

In the **attach completion path** (where `currentInstanceRegistry`, `currentHookStore` are created — search for `new InstanceRegistry()`), add after they're created:

```ts
        const scriptsDir = path.join(profile.dir, "plugins", "scripts");
        emitScriptsTypes(scriptsDir);
        const loader = new ScriptLoader(scriptsDir);
        await loader.start();
        loader.on("change", (entry) => this.emit("script-list-changed", entry));
        loader.on("remove", (id)    => this.emit("script-list-changed", { removed: id }));
        this.currentScriptLoader = loader;

        const runner = new ScriptRunner(
            loader,
            {
                instanceRegistry: this.currentInstanceRegistry,
                hookStore:        this.currentHookStore,
                frameStore:       this.currentFrameStore,
                agentCall:        (m, a) => this.fridaClient.call(m, a),
                resolveLabel:     (l) => l, // v1.4: identity. Friendly→obf wiring deferred until session exposes labelStore() — see Spec coverage caveat.
            },
            buildToolkit,
        );
        runner.on("log",    (e) => this.emit("script-log", e));
        runner.on("result", (r) => this.emit("script-result", r));
        this.currentScriptRunner = runner;
```

In the **detach path** (search for `this.currentInstanceRegistry = null`), add:

```ts
        if (this.currentScriptLoader) { void this.currentScriptLoader.dispose(); this.currentScriptLoader = null; }
        this.currentScriptRunner = null;
```

In the **agent-message** handler (search for `hook-event` forwarding or the `agent-message` listener), add hook-event routing to the new HookStore.notifyAgentEvent:

```ts
        this.fridaClient.on("agent-message", (payload: { type?: string; hookId?: string; args?: unknown[] }) => {
            // ... existing code ...
            if (payload?.type === "hook-event" && this.currentHookStore && payload.hookId) {
                this.currentHookStore.notifyAgentEvent(payload.hookId, payload.args ?? []);
            }
        });
```

(Place this addition WITHOUT disturbing existing `agent-message` listeners — find the existing one and add the conditional.)

- [ ] **Step 2: Forward script events in ws-bridge.ts**

In `app/backend/ws-bridge.ts`, after the existing `session.on("agent-message", ...)` block, add:

```ts
    session.on("script-list-changed", (e: unknown) => broadcast({ type: "script-list-changed", payload: e }));
    session.on("script-log",          (e: unknown) => broadcast({ type: "script-log",          payload: e }));
    session.on("script-result",       (e: unknown) => broadcast({ type: "script-result",       payload: e }));
```

- [ ] **Step 3: Mount the route in server.ts**

Find where `mountInstances(app, ...)` is called in `app/backend/server.ts`. Add nearby:

```ts
import { mountScripts } from "./routes/scripts.js";

// ... in setup ...
mountScripts(app, {
    loader: () => session.scriptLoader(),
    runner: () => session.scriptRunner(),
});
```

- [ ] **Step 4: Run all backend tests + type-check**

```bash
cd app && npx vitest run test/backend/ && npx tsc -p tsconfig.backend.json --noEmit
```

Expected: all backend tests passing, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add app/backend/session.ts app/backend/ws-bridge.ts app/backend/server.ts
git commit -m "feat(scripts): wire ScriptLoader+Runner into session, forward WS events, mount routes"
```

---

## Task 14: Frontend page — list + form + run + WS streaming

**Files:**
- Create: `app/frontend/pages/scripts.ts`
- Modify: `app/frontend/main.ts` (register route)
- Modify: `app/frontend/index.html` (nav entry)
- Test: `app/test/frontend/pages/scripts.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/test/frontend/pages/scripts.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";

import { renderScriptsPage } from "../../../frontend/pages/scripts";

describe("scripts page", () => {
    let window: Window;
    let document: Document;
    let host: HTMLElement;

    beforeEach(() => {
        window = new Window();
        document = window.document as unknown as Document;
        host = document.createElement("div") as unknown as HTMLElement;
        document.body.appendChild(host);

        // Mock fetch for /api/scripts
        (globalThis as { fetch?: unknown }).fetch = vi.fn(async (url: string) => {
            if (url === "/api/scripts") {
                return {
                    ok: true,
                    json: async () => ({
                        scripts: [
                            { id: "echo", status: "loaded", definition: { name: "echo", description: "echoes", params: { msg: { type: "string", required: true } } }, filePath: "/p/echo.ts", loadedAt: "" },
                            { id: "boom", status: "compile-error", error: "boom", filePath: "/p/boom.ts", loadedAt: "" },
                        ],
                    }),
                } as Response;
            }
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        }) as never;
    });

    it("renders the script list", async () => {
        await renderScriptsPage(host);
        const items = host.querySelectorAll("[data-testid='script-item']");
        expect(items.length).toBe(2);
    });

    it("clicking a loaded script shows the param form", async () => {
        await renderScriptsPage(host);
        const echoItem = host.querySelector("[data-script-id='echo']") as HTMLElement;
        echoItem.click();
        const input = host.querySelector("[data-param='msg']") as HTMLInputElement;
        expect(input).not.toBeNull();
        expect(input.placeholder).toBeDefined();
    });

    it("compile-error script shows error inline, no run button", async () => {
        await renderScriptsPage(host);
        const boomItem = host.querySelector("[data-script-id='boom']") as HTMLElement;
        boomItem.click();
        expect(host.querySelector("[data-testid='script-error']")?.textContent).toMatch(/boom/);
        expect(host.querySelector("[data-testid='run-btn']")).toBeNull();
    });

    it("submitting form posts to /api/scripts/:id/run", async () => {
        const fetchMock = (globalThis as { fetch: ReturnType<typeof vi.fn> }).fetch;
        await renderScriptsPage(host);
        (host.querySelector("[data-script-id='echo']") as HTMLElement).click();
        (host.querySelector("[data-param='msg']") as HTMLInputElement).value = "hello";
        // Re-mock for the run call
        fetchMock.mockResolvedValueOnce({
            ok: true, json: async () => ({ runId: "r-99" }),
        } as Response);
        (host.querySelector("[data-testid='run-btn']") as HTMLButtonElement).click();
        // Wait a tick
        await new Promise((r) => setTimeout(r, 10));
        const calls = fetchMock.mock.calls;
        const runCall = calls.find((c) => String(c[0]).endsWith("/api/scripts/echo/run"));
        expect(runCall).toBeDefined();
        expect(JSON.parse((runCall![1] as { body: string }).body)).toEqual({ params: { msg: "hello" } });
    });

    it("appends WS log events to the console", async () => {
        await renderScriptsPage(host);
        // Simulate a WS event arriving
        const evt = new (window.CustomEvent as unknown as typeof CustomEvent)("script-log", {
            detail: { runId: "r-99", level: "info", args: ["hello", 42], ts: "" },
        });
        host.dispatchEvent(evt);
        const console_ = host.querySelector("[data-testid='console']");
        expect(console_?.textContent).toMatch(/hello/);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd app && npx vitest run test/frontend/pages/scripts.test.ts
```

Expected: ALL FAIL.

- [ ] **Step 3: Implement `frontend/pages/scripts.ts`**

`app/frontend/pages/scripts.ts`:

```ts
// Frontend page: list scripts (left), param form + console (right).
// WS events `script-list-changed`, `script-log`, `script-result` arrive via the
// shared bridge in main.ts and are dispatched to this host element as
// CustomEvent of the same name.

interface ParamSpec {
    type: "string" | "number" | "boolean" | "enum";
    label?: string; required?: boolean; default?: unknown;
    placeholder?: string; min?: number; max?: number; values?: readonly string[];
}

interface RegistryEntry {
    id: string;
    filePath: string;
    status: "loaded" | "compile-error" | "validation-error";
    definition?: { name: string; description?: string; params: Record<string, ParamSpec>; timeoutMs?: number };
    error?: string;
    loadedAt: string;
}

let scripts: RegistryEntry[] = [];
let selected: string | null = null;

export async function renderScriptsPage(host: HTMLElement): Promise<void> {
    host.innerHTML = `
        <div style="display:flex;height:100%">
            <div data-testid="list" style="width:240px;border-right:1px solid #333;overflow:auto"></div>
            <div data-testid="detail" style="flex:1;display:flex;flex-direction:column"></div>
        </div>
    `;

    await refresh(host);

    // WS event hook-up. main.ts is responsible for dispatching CustomEvents on this host.
    host.addEventListener("script-list-changed", () => { void refresh(host); });
    host.addEventListener("script-log",   ((e: Event) => appendLog(host, (e as CustomEvent).detail)) as EventListener);
    host.addEventListener("script-result", ((e: Event) => appendResult(host, (e as CustomEvent).detail)) as EventListener);
}

async function refresh(host: HTMLElement): Promise<void> {
    const r = await fetch("/api/scripts");
    const data = await r.json() as { scripts: RegistryEntry[] };
    scripts = data.scripts;
    renderList(host);
    if (selected && !scripts.find((s) => s.id === selected)) selected = null;
    if (selected) renderDetail(host, scripts.find((s) => s.id === selected)!);
}

function renderList(host: HTMLElement): void {
    const list = host.querySelector("[data-testid='list']") as HTMLElement;
    list.innerHTML = "";
    for (const s of scripts) {
        const icon = s.status === "loaded" ? "▶" : "⚠";
        const div = document.createElement("div");
        div.setAttribute("data-testid", "script-item");
        div.setAttribute("data-script-id", s.id);
        div.style.cssText = "padding:6px;cursor:pointer;border-bottom:1px solid #222";
        div.textContent = `${icon} ${s.definition?.name ?? s.id}`;
        if (selected === s.id) div.style.background = "#1e3a8a";
        div.addEventListener("click", () => { selected = s.id; renderList(host); renderDetail(host, s); });
        list.appendChild(div);
    }
}

function renderDetail(host: HTMLElement, s: RegistryEntry): void {
    const detail = host.querySelector("[data-testid='detail']") as HTMLElement;
    if (s.status !== "loaded") {
        detail.innerHTML = `
            <div style="padding:12px">
                <h2>${escapeHtml(s.id)}</h2>
                <pre data-testid="script-error" style="color:#f87171;white-space:pre-wrap">${escapeHtml(s.error ?? "unknown error")}</pre>
            </div>
        `;
        return;
    }
    const def = s.definition!;
    const formInputs = Object.entries(def.params).map(([k, spec]) => renderInput(k, spec)).join("");
    detail.innerHTML = `
        <div style="padding:12px;border-bottom:1px solid #333">
            <h2>${escapeHtml(def.name)}</h2>
            <p>${escapeHtml(def.description ?? "")}</p>
            <form data-testid="form">${formInputs}</form>
            <button data-testid="run-btn" style="margin-top:8px">▶ Run</button>
        </div>
        <pre data-testid="console" style="flex:1;overflow:auto;margin:0;padding:8px;background:#0a0a0a;color:#cbd5e1;white-space:pre-wrap"></pre>
    `;
    (detail.querySelector("[data-testid='run-btn']") as HTMLButtonElement)
        .addEventListener("click", () => void runSelected(host, s));
}

function renderInput(key: string, spec: ParamSpec): string {
    const label = `<label style="display:block;margin-top:6px">${escapeHtml(spec.label ?? key)}${spec.required ? "*" : ""}</label>`;
    if (spec.type === "boolean") {
        const checked = spec.default ? "checked" : "";
        return `${label}<input data-param="${escapeHtml(key)}" type="checkbox" ${checked}/>`;
    }
    if (spec.type === "enum") {
        const opts = (spec.values ?? []).map((v) => `<option ${v === spec.default ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
        return `${label}<select data-param="${escapeHtml(key)}">${opts}</select>`;
    }
    const type = spec.type === "number" ? "number" : "text";
    const placeholder = spec.placeholder ? `placeholder="${escapeHtml(spec.placeholder)}"` : "";
    const def = spec.default !== undefined ? `value="${escapeHtml(String(spec.default))}"` : "";
    return `${label}<input data-param="${escapeHtml(key)}" type="${type}" ${placeholder} ${def}/>`;
}

async function runSelected(host: HTMLElement, s: RegistryEntry): Promise<void> {
    const def = s.definition!;
    const params: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(def.params)) {
        const el = host.querySelector(`[data-param="${k}"]`) as HTMLInputElement | HTMLSelectElement | null;
        if (!el) continue;
        if (spec.type === "boolean") params[k] = (el as HTMLInputElement).checked;
        else if (spec.type === "number") {
            const v = (el as HTMLInputElement).value;
            if (v !== "") params[k] = Number(v);
        } else {
            const v = el.value;
            if (v !== "") params[k] = v;
        }
    }
    const r = await fetch(`/api/scripts/${encodeURIComponent(s.id)}/run`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
    });
    const body = await r.json() as { runId?: string; error?: string };
    if (!r.ok) appendLog(host, { level: "error", args: [body.error ?? "run failed"], ts: new Date().toISOString(), runId: "" });
    else appendLog(host, { level: "info", args: [`▶ Run ${body.runId} started`], ts: new Date().toISOString(), runId: body.runId ?? "" });
}

function appendLog(host: HTMLElement, log: { runId: string; level: string; args: unknown[]; ts: string }): void {
    const c = host.querySelector("[data-testid='console']");
    if (!c) return;
    const ts = (log.ts || new Date().toISOString()).slice(11, 23);
    c.textContent += `${ts} [${log.level}] ${log.args.map(stringify).join(" ")}\n`;
    (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
}

function appendResult(host: HTMLElement, r: { runId: string; status: string; result?: unknown; error?: { message: string }; durationMs: number }): void {
    const c = host.querySelector("[data-testid='console']");
    if (!c) return;
    const icon = r.status === "ok" ? "✓" : r.status === "timeout" ? "⏱" : "✗";
    const tail = r.status === "ok" ? `result: ${stringify(r.result)}` : `error: ${r.error?.message ?? ""}`;
    c.textContent += `${icon} ${r.status} (${r.durationMs}ms) ${tail}\n`;
}

function stringify(v: unknown): string {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

- [ ] **Step 4: Wire route in main.ts and add nav entry**

In `app/frontend/main.ts`, find where other pages are registered (search for `instances`/`hooks`). Add:

```ts
import { renderScriptsPage } from "./pages/scripts.js";

// ... in router setup ...
case "#/scripts":
    await renderScriptsPage(pageHost);
    break;
```

In the WS message handler (search for `script-log` is not present yet — find where `hook-event` is dispatched):

```ts
ws.addEventListener("message", (evt) => {
    const msg = JSON.parse(evt.data as string);
    // ... existing dispatchers ...
    if (msg.type === "script-list-changed" || msg.type === "script-log" || msg.type === "script-result") {
        pageHost.dispatchEvent(new CustomEvent(msg.type, { detail: msg.payload }));
    }
});
```

In `app/frontend/index.html`, add a nav link near the existing ones:

```html
<a href="#/scripts" data-nav="scripts">Scripts</a>
```

- [ ] **Step 5: Run frontend tests**

```bash
cd app && npx vitest run test/frontend/pages/scripts.test.ts
```

Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add app/frontend/pages/scripts.ts app/frontend/main.ts app/frontend/index.html app/test/frontend/pages/scripts.test.ts
git commit -m "feat(scripts): frontend page — list + auto-generated form + WS log streaming"
```

---

## Task 15: End-to-end smoke + docs polish

**Files:**
- Modify: `app/SMOKE-TEST.md` (append a Scripts section)

- [ ] **Step 1: Run the full test suite**

```bash
cd app && npx vitest run && npx tsc -p tsconfig.backend.json --noEmit && npm run build
```

Expected: all tests passing (~230 expected per spec), no TS errors, build clean.

- [ ] **Step 2: Manual smoke test on Dofus** (or any IL2CPP build the user has profiled)

1. Start the backend: `cd app && npm run dev`
2. Attach to the game.
3. In the profile dir (logged in console at attach), confirm `<profile>/plugins/scripts/_types/toolkit.d.ts` and `tsconfig.json` were emitted.
4. Create a file `<profile>/plugins/scripts/auto-travel.ts`:

```ts
import { defineScript } from "@toolkit/scripts";

export default defineScript({
    name: "autoTravel",
    description: "Travel to a specific map by mapId.",
    params: { mapId: { type: "number", label: "Map ID", required: true } },
    run: async ({ mapId }, toolkit) => {
        const player = await toolkit.instances.find("PlayerManager");
        toolkit.log("currentMapId before:", await toolkit.instances.read(player, "currentMapId"));
        const mgr = await toolkit.instances.find("MapManager");
        await toolkit.instances.call(mgr, "TravelTo", [mapId]);
        return `→ map ${mapId}`;
    },
});
```

5. Open the web-app, navigate to `#/scripts`. Verify `autoTravel` appears within ~1s of save (chokidar debounce).
6. Click `autoTravel`, fill `Map ID = <a valid map>`, click Run. Verify:
   - Log line `currentMapId before: ...` streams.
   - Result `→ map <mapId>` appears.
   - Game travels in-game.
7. Edit the file to introduce a syntax error. Save. Verify the icon flips to ⚠ and clicking shows the error.
8. Edit the file with a deliberate `throw new Error('boom')` on line 6. Save. Run. Verify the stack-trace in the result console shows `auto-travel.ts:6`.

- [ ] **Step 3: Append smoke results to `app/SMOKE-TEST.md`**

Append:

```markdown
## v1.4 Plugin Scripts (2026-05-07)

- [x] Profile bootstrap emits `_types/toolkit.d.ts` + `tsconfig.json`
- [x] Hot-reload picks up new file on save (~300ms)
- [x] autoTravel script runs and triggers MapManager.TravelTo
- [x] Compile error → ⚠ in list, error visible in detail
- [x] Runtime error → stack-trace points to `.ts` source line
- [x] VSCode autocomplete works on `<profile>/plugins/scripts/` after first attach
```

- [ ] **Step 4: Final commit**

```bash
git add app/SMOKE-TEST.md
git commit -m "test(scripts): smoke test results + checklist for v1.4"
```

---

## Spec coverage check

| Spec section | Covered by |
|---|---|
| Architecture (file layout) | T1, T3–T14 |
| `defineScript` factory + types | T1 |
| `ParamSpec` discriminated union | T1, T2 |
| ScriptLoader + esbuild compile | T3 |
| chokidar watch + duplicate guard | T4 |
| Toolkit API (instances/hooks/network/utils) | T5–T8 |
| Friendly→obf label resolution | T5 (stub via `resolveLabel`), T13 (wired identity for now; TODO upgrade when LabelStore exposed on session) |
| ScriptRunner (validate/run/timeout/concurrency/serialize) | T9 |
| Source-map error remapping | T10 |
| `_types/toolkit.d.ts` + `tsconfig.json` emitter | T11 |
| HTTP routes | T12 |
| Session + ws-bridge wiring | T13 |
| Frontend page (list + form + console + WS) | T14 |
| Smoke test on Dofus | T15 |

**Caveat:** T13 wires `resolveLabel: (l) => l` (identity). The spec says friendly labels must auto-resolve. The full label resolution depends on having `LabelStore` exposed on `Session` in a way that script-runner can consume — if not present, follow-up: add a `session.labelStore()` getter + change `resolveLabel` in T13 to `(l) => session.labelStore()?.resolveFriendly(l) ?? l`. This is a small addition and can be done as part of T13 if the API exists, or a follow-up commit.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-07-frida-toolkit-plugin-scripts.md`.**

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session, batch with checkpoints for review.

Which approach?
