# Plugin Instances (v1.4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Énumérer, lire, éditer des instances IL2CPP vivantes via une page UI dédiée, avec persistance des "recettes" de capture per-profile.

**Architecture:** L'agent a déjà ~13 primitives dans `src/rpc-agent/instance-ops.ts` exposées via `instanceOpsRpc`. v1.4 ajoute : (1) une couche backend avec 3 stores (`InstanceRegistry` ephemeral, `RecipeStore` persistant, `HistoryStore` ring 50), (2) un moteur de replay, (3) ~14 routes REST, (4) une page UI 3-pane (sidebar captures / viewer central / history panel). Lecture par défaut, écriture derrière un toggle Read-Only, calls de méthodes derrière confirmation modale.

**Tech Stack:** TypeScript, Node.js, vitest (backend tests), supertest (route tests), happy-dom (frontend tests), vanilla TS + Vite (frontend), frida-il2cpp-bridge (agent VM).

**Spec source:** [docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-instances-design.md](docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-instances-design.md) (commit `13001ac`)

---

## Task 1: Backend types (`core/instances/types.ts`)

**Files:**
- Create: `app/backend/core/instances/types.ts`

- [ ] **Step 1: Create the types file**

Create `app/backend/core/instances/types.ts` with:

```typescript
// Shared types for the v1.4 Instances plugin.
// See docs/superpowers/specs/2026-05-07-frida-toolkit-plugin-instances-design.md

// ---------------------------------------------------------------------------
// Recipe — persisted, replayable chain of capture operations
// ---------------------------------------------------------------------------

export type RecipeStep =
    | { op: "captureViaGC"; className: string; index: number; asKey: string }
    | { op: "captureViaHook"; className: string; tickMethod: string; timeoutMs: number; asKey: string }
    | { op: "captureFieldValue"; ownerKey: string; fieldName: string; asKey: string }
    | { op: "captureListElement"; ownerKey: string; listFieldName: string; index: number; asKey: string }
    | { op: "captureMethodReturn"; ownerKey: string; methodName: string; args: unknown[]; asKey: string };

export interface Recipe {
    id: string;
    name: string;
    description?: string;
    steps: RecipeStep[];
    createdAt: string;
    updatedAt: string;
    lastReplayedAt?: string;
    lastReplayStatus?: "ok" | "partial" | "failed";
}

export interface RecipeStoreSchemaV1 {
    schemaVersion: 1;
    recipes: Recipe[];
}

// ---------------------------------------------------------------------------
// CapturedInstance — in-memory entry in the registry
// ---------------------------------------------------------------------------

export interface CapturedInstance {
    key: string;
    className: string;
    handle: string;
    capturedAt: string;
    capturedVia: RecipeStep["op"];
    isAlive: boolean;
}

// ---------------------------------------------------------------------------
// FieldRead — structured read result for one field
// ---------------------------------------------------------------------------

export type FieldKind = "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";

export interface FieldRead {
    name: string;
    typeName: string;
    kind: FieldKind;
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

// ---------------------------------------------------------------------------
// HistoryEntry — audit trail of mutations during this session
// ---------------------------------------------------------------------------

export interface HistoryEntry {
    id: string;
    timestamp: string;
    action: "write" | "call";
    target: { instanceKey: string; member: string };
    before?: string;
    after?: string;
    callArgs?: unknown[];
    callResult?: string;
    success: boolean;
    error?: string;
}

// ---------------------------------------------------------------------------
// Replay result — returned by replay engine + recipes/:id/replay route
// ---------------------------------------------------------------------------

export interface RecipeStepResult {
    stepIndex: number;
    op: RecipeStep["op"];
    asKey: string;
    ok: boolean;
    summary?: string;
    error?: string;
}

export interface RecipeReplayResult {
    steps: RecipeStepResult[];
    finalStatus: "ok" | "partial" | "failed";
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Expected: PASS (file is self-contained, no imports yet).

- [ ] **Step 3: Commit**

```bash
git add app/backend/core/instances/types.ts
git commit -m "feat(instances): add v1.4 core types (Recipe/CapturedInstance/FieldRead/HistoryEntry)"
```

---

## Task 2: `InstanceRegistry` — in-memory map + tests

**Files:**
- Create: `app/backend/core/instances/instance-registry.ts`
- Test: `app/test/backend/core/instances/instance-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/test/backend/core/instances/instance-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { InstanceRegistry } from "../../../../backend/core/instances/instance-registry";

describe("InstanceRegistry", () => {
    let reg: InstanceRegistry;
    beforeEach(() => { reg = new InstanceRegistry(); });

    it("set + get returns the entry", () => {
        reg.set("player", "PlayerCharacter", "0x5af", "captureViaGC");
        const got = reg.get("player");
        expect(got).not.toBeNull();
        expect(got!.className).toBe("PlayerCharacter");
        expect(got!.handle).toBe("0x5af");
        expect(got!.capturedVia).toBe("captureViaGC");
        expect(got!.isAlive).toBe(true);
    });

    it("set on existing key overwrites", () => {
        reg.set("player", "OldClass", "0x1", "captureViaGC");
        reg.set("player", "NewClass", "0x2", "captureViaHook");
        expect(reg.get("player")!.className).toBe("NewClass");
    });

    it("delete removes the entry", () => {
        reg.set("player", "PlayerCharacter", "0x5af", "captureViaGC");
        reg.delete("player");
        expect(reg.get("player")).toBeNull();
    });

    it("list returns all entries in insertion order", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.set("c", "C", "0x3", "captureViaGC");
        expect(reg.list().map((e) => e.key)).toEqual(["a", "b", "c"]);
    });

    it("clear empties the registry", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.clear();
        expect(reg.list()).toHaveLength(0);
    });

    it("onChange emits on set/delete/clear", () => {
        let count = 0;
        reg.onChange(() => { count++; });
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.delete("a");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.clear();
        expect(count).toBe(4);
    });

    it("setAlive(false) marks the entry as dead", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.setAlive("a", false);
        expect(reg.get("a")!.isAlive).toBe(false);
    });
});
```

Run: `cd app && npx vitest run test/backend/core/instances/instance-registry.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement**

Create `app/backend/core/instances/instance-registry.ts`:

```typescript
import type { CapturedInstance, RecipeStep } from "./types";

type Listener = () => void;

export class InstanceRegistry {
    private entries = new Map<string, CapturedInstance>();
    private listeners: Listener[] = [];

    set(key: string, className: string, handle: string, via: RecipeStep["op"]): void {
        this.entries.set(key, {
            key, className, handle,
            capturedAt: new Date().toISOString(),
            capturedVia: via,
            isAlive: true,
        });
        this.emit();
    }

    get(key: string): CapturedInstance | null {
        return this.entries.get(key) ?? null;
    }

    list(): CapturedInstance[] {
        return Array.from(this.entries.values());
    }

    delete(key: string): void {
        if (this.entries.delete(key)) this.emit();
    }

    clear(): void {
        if (this.entries.size === 0) return;
        this.entries.clear();
        this.emit();
    }

    setAlive(key: string, alive: boolean): void {
        const entry = this.entries.get(key);
        if (!entry || entry.isAlive === alive) return;
        entry.isAlive = alive;
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
}
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/core/instances/instance-registry.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 4: Commit**

```bash
git add app/backend/core/instances/instance-registry.ts app/test/backend/core/instances/instance-registry.test.ts
git commit -m "feat(instances): InstanceRegistry — in-memory live capture map"
```

---

## Task 3: `HistoryStore` — ring buffer 50 entries + tests

**Files:**
- Create: `app/backend/core/instances/history-store.ts`
- Test: `app/test/backend/core/instances/history-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/test/backend/core/instances/history-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { HistoryStore } from "../../../../backend/core/instances/history-store";
import type { HistoryEntry } from "../../../../backend/core/instances/types";

const makeEntry = (id: string): HistoryEntry => ({
    id,
    timestamp: new Date().toISOString(),
    action: "write",
    target: { instanceKey: "player", member: "health" },
    before: "100",
    after: "9999",
    success: true,
});

describe("HistoryStore", () => {
    let h: HistoryStore;
    beforeEach(() => { h = new HistoryStore(); });

    it("append + list returns entries in reverse chronological order", () => {
        h.append(makeEntry("a"));
        h.append(makeEntry("b"));
        h.append(makeEntry("c"));
        expect(h.list().map((e) => e.id)).toEqual(["c", "b", "a"]);
    });

    it("evicts oldest beyond MAX (50)", () => {
        for (let i = 0; i < 51; i++) h.append(makeEntry(`e${i}`));
        const list = h.list();
        expect(list).toHaveLength(50);
        expect(list[0].id).toBe("e50");        // newest first
        expect(list[49].id).toBe("e1");        // e0 was evicted
    });

    it("clear empties the store", () => {
        h.append(makeEntry("a"));
        h.clear();
        expect(h.list()).toHaveLength(0);
    });

    it("onChange emits on append + clear", () => {
        let count = 0;
        h.onChange(() => { count++; });
        h.append(makeEntry("a"));
        h.append(makeEntry("b"));
        h.clear();
        expect(count).toBe(3);
    });
});
```

Run: `cd app && npx vitest run test/backend/core/instances/history-store.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

Create `app/backend/core/instances/history-store.ts`:

```typescript
import type { HistoryEntry } from "./types";

type Listener = () => void;

export class HistoryStore {
    private static readonly MAX = 50;
    private entries: HistoryEntry[] = [];
    private listeners: Listener[] = [];

    append(entry: HistoryEntry): void {
        this.entries.push(entry);
        if (this.entries.length > HistoryStore.MAX) {
            this.entries.splice(0, this.entries.length - HistoryStore.MAX);
        }
        this.emit();
    }

    list(): HistoryEntry[] {
        return this.entries.slice().reverse();
    }

    clear(): void {
        if (this.entries.length === 0) return;
        this.entries.length = 0;
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
}
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/core/instances/history-store.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 4: Commit**

```bash
git add app/backend/core/instances/history-store.ts app/test/backend/core/instances/history-store.test.ts
git commit -m "feat(instances): HistoryStore — 50-entry ring buffer audit trail"
```

---

## Task 4: `RecipeStore` — persisted via DiskPluginStorage + tests

**Files:**
- Create: `app/backend/core/instances/recipe-store.ts`
- Test: `app/test/backend/core/instances/recipe-store.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/test/backend/core/instances/recipe-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecipeStore } from "../../../../backend/core/instances/recipe-store";
import { DiskPluginStorage } from "../../../../backend/core/plugin-storage";
import type { RecipeStep } from "../../../../backend/core/instances/types";

const sampleSteps: RecipeStep[] = [
    { op: "captureViaGC", className: "PlayerCharacter", index: 0, asKey: "player" },
    { op: "captureFieldValue", ownerKey: "player", fieldName: "inventory", asKey: "inv" },
];

function makeStore(): { store: RecipeStore; tmpDir: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-store-"));
    const storage = new DiskPluginStorage(tmpDir, "instances");
    const store = new RecipeStore(storage);
    return { store, tmpDir };
}

describe("RecipeStore", () => {
    it("add creates a recipe and persists to disk", async () => {
        const { store, tmpDir } = makeStore();
        const r = store.add("player+inv", sampleSteps);
        expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.name).toBe("player+inv");
        expect(r.steps).toEqual(sampleSteps);
        await store.flush();

        const file = path.join(tmpDir, "plugins", "instances", "recipe-store.json");
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        expect(raw.schemaVersion).toBe(1);
        expect(raw.recipes).toHaveLength(1);
        expect(raw.recipes[0].name).toBe("player+inv");
    });

    it("list returns all recipes", () => {
        const { store } = makeStore();
        store.add("a", sampleSteps);
        store.add("b", sampleSteps);
        expect(store.list()).toHaveLength(2);
    });

    it("get returns a single recipe by id", () => {
        const { store } = makeStore();
        const r = store.add("a", sampleSteps);
        expect(store.get(r.id)?.name).toBe("a");
        expect(store.get("missing-id")).toBeNull();
    });

    it("update mutates fields and updates updatedAt", async () => {
        const { store } = makeStore();
        const r = store.add("a", sampleSteps);
        const oldUpdatedAt = r.updatedAt;
        await new Promise((res) => setTimeout(res, 5));
        store.update(r.id, { name: "renamed", lastReplayStatus: "ok" });
        const after = store.get(r.id)!;
        expect(after.name).toBe("renamed");
        expect(after.lastReplayStatus).toBe("ok");
        expect(after.updatedAt).not.toBe(oldUpdatedAt);
    });

    it("delete removes a recipe", () => {
        const { store } = makeStore();
        const r = store.add("a", sampleSteps);
        store.delete(r.id);
        expect(store.get(r.id)).toBeNull();
    });

    it("reload from disk restores state", async () => {
        const { store: s1, tmpDir } = makeStore();
        s1.add("persisted", sampleSteps);
        await s1.flush();

        const storage2 = new DiskPluginStorage(tmpDir, "instances");
        const s2 = new RecipeStore(storage2);
        const list = s2.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("persisted");
    });

    it("onChange emits on add/update/delete", () => {
        const { store } = makeStore();
        let count = 0;
        store.onChange(() => { count++; });
        const r = store.add("a", sampleSteps);
        store.update(r.id, { name: "b" });
        store.delete(r.id);
        expect(count).toBe(3);
    });

    it("corrupt JSON is recovered cleanly (empty store)", () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-store-corrupt-"));
        const dir = path.join(tmpDir, "plugins", "instances");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "recipe-store.json"), "not valid json {");
        const storage = new DiskPluginStorage(tmpDir, "instances");
        const store = new RecipeStore(storage);
        expect(store.list()).toHaveLength(0);
    });
});
```

Run: `cd app && npx vitest run test/backend/core/instances/recipe-store.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Read existing DiskPluginStorage interface**

Run: `head -60 app/backend/core/plugin-storage.ts`

Note the `read(filename)`/`write(filename, data)` interface — `RecipeStore` will use this exact API (same pattern as `serializer-config.ts`).

- [ ] **Step 3: Implement**

Create `app/backend/core/instances/recipe-store.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type { DiskPluginStorage } from "../plugin-storage";
import type { Recipe, RecipeStep, RecipeStoreSchemaV1 } from "./types";

const FILE = "recipe-store.json";
const SCHEMA_VERSION = 1;

type Listener = () => void;

export class RecipeStore {
    private recipes: Recipe[] = [];
    private dirty = false;
    private flushPromise: Promise<void> = Promise.resolve();
    private listeners: Listener[] = [];

    constructor(private readonly storage: DiskPluginStorage) {
        this.loadFromDisk();
    }

    list(): Recipe[] {
        return this.recipes.slice();
    }

    get(id: string): Recipe | null {
        return this.recipes.find((r) => r.id === id) ?? null;
    }

    add(name: string, steps: RecipeStep[], description?: string): Recipe {
        const now = new Date().toISOString();
        const recipe: Recipe = {
            id: randomUUID(),
            name,
            description,
            steps,
            createdAt: now,
            updatedAt: now,
        };
        this.recipes.push(recipe);
        this.dirty = true;
        this.scheduleFlush();
        this.emit();
        return recipe;
    }

    update(
        id: string,
        patch: Partial<Pick<Recipe, "name" | "description" | "steps" | "lastReplayedAt" | "lastReplayStatus">>,
    ): void {
        const r = this.recipes.find((x) => x.id === id);
        if (!r) return;
        Object.assign(r, patch);
        r.updatedAt = new Date().toISOString();
        this.dirty = true;
        this.scheduleFlush();
        this.emit();
    }

    delete(id: string): void {
        const i = this.recipes.findIndex((r) => r.id === id);
        if (i < 0) return;
        this.recipes.splice(i, 1);
        this.dirty = true;
        this.scheduleFlush();
        this.emit();
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        };
    }

    async flush(): Promise<void> {
        if (!this.dirty) return this.flushPromise;
        this.dirty = false;
        const data: RecipeStoreSchemaV1 = { schemaVersion: SCHEMA_VERSION, recipes: this.recipes };
        this.flushPromise = this.storage.write(FILE, JSON.stringify(data, null, 2));
        return this.flushPromise;
    }

    private scheduleFlush(): void {
        // Coalesced flush — caller can `await flush()` to drain immediately.
        void this.flush().catch(() => { /* surfaced via test that explicitly awaits */ });
    }

    private loadFromDisk(): void {
        try {
            const raw = this.storage.readSync(FILE);
            if (!raw) return;
            const parsed = JSON.parse(raw) as RecipeStoreSchemaV1;
            if (parsed.schemaVersion === SCHEMA_VERSION) {
                this.recipes = parsed.recipes ?? [];
            }
        } catch {
            // corrupt or missing — empty store
        }
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }
}
```

NOTE: Check whether `DiskPluginStorage` has a synchronous `readSync` method. If it only has async `read`, the constructor needs to defer loading or accept an async init. Run:

Run: `grep -n "readSync\|read(" app/backend/core/plugin-storage.ts | head -10`

If `readSync` doesn't exist, replace `loadFromDisk` with an async version called explicitly:

```typescript
async init(): Promise<void> {
    try {
        const raw = await this.storage.read(FILE);
        if (!raw) return;
        const parsed = JSON.parse(raw) as RecipeStoreSchemaV1;
        if (parsed.schemaVersion === SCHEMA_VERSION) {
            this.recipes = parsed.recipes ?? [];
        }
    } catch { /* corrupt or missing */ }
}
```

And remove `loadFromDisk()` from the constructor. Tests would then call `await store.init()` after construction. Adjust the test file accordingly if needed.

- [ ] **Step 4: Run tests**

Run: `cd app && npx vitest run test/backend/core/instances/recipe-store.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Commit**

```bash
git add app/backend/core/instances/recipe-store.ts app/test/backend/core/instances/recipe-store.test.ts
git commit -m "feat(instances): RecipeStore — persisted recipe library via DiskPluginStorage"
```

---

## Task 5: Replay engine + tests

**Files:**
- Create: `app/backend/core/instances/replay.ts`
- Test: `app/test/backend/core/instances/replay.test.ts`

- [ ] **Step 1: Write failing tests**

Create `app/test/backend/core/instances/replay.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { replayRecipe } from "../../../../backend/core/instances/replay";
import { InstanceRegistry } from "../../../../backend/core/instances/instance-registry";
import type { Recipe, RecipeStep } from "../../../../backend/core/instances/types";

interface MockAgent {
    captureViaGC: (className: string, index: number) => Promise<{ className: string; handle: string }>;
    captureViaHook: (className: string, tickMethod: string, timeoutMs: number) => Promise<{ className: string; handle: string }>;
    captureFieldValue: (ownerKey: string, fieldName: string, asKey: string) => Promise<{ className: string; handle: string }>;
    captureListElement: (listClassName: string, listFieldName: string, index: number, asKey: string) => Promise<{ className: string; handle: string }>;
    captureMethodReturn: (ownerKey: string, methodName: string, args: unknown[], asKey: string) => Promise<{ className: string; handle: string }>;
}

const okAgent: MockAgent = {
    captureViaGC: async (cn) => ({ className: cn, handle: "0xGC" }),
    captureViaHook: async (cn) => ({ className: cn, handle: "0xHK" }),
    captureFieldValue: async () => ({ className: "Inner", handle: "0xFV" }),
    captureListElement: async () => ({ className: "Item", handle: "0xLE" }),
    captureMethodReturn: async () => ({ className: "Ret", handle: "0xMR" }),
};

const recipe = (steps: RecipeStep[]): Recipe => ({
    id: "r1", name: "test", steps,
    createdAt: "2026-05-07T00:00:00Z",
    updatedAt: "2026-05-07T00:00:00Z",
});

describe("replayRecipe", () => {
    let reg: InstanceRegistry;
    beforeEach(() => { reg = new InstanceRegistry(); });

    it("executes all steps in order on the success path", async () => {
        const order: string[] = [];
        const agent: MockAgent = {
            ...okAgent,
            captureViaGC: async (cn) => { order.push(`GC:${cn}`); return { className: cn, handle: "0x1" }; },
            captureFieldValue: async (_o, f) => { order.push(`FV:${f}`); return { className: "I", handle: "0x2" }; },
        };
        const r = recipe([
            { op: "captureViaGC", className: "Player", index: 0, asKey: "player" },
            { op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(order).toEqual(["GC:Player", "FV:inv"]);
        expect(result.finalStatus).toBe("ok");
        expect(reg.get("player")?.handle).toBe("0x1");
        expect(reg.get("inv")?.handle).toBe("0x2");
    });

    it("continues after a failed step (best-effort)", async () => {
        const agent: MockAgent = {
            ...okAgent,
            captureFieldValue: async () => { throw new Error("boom"); },
        };
        const r = recipe([
            { op: "captureViaGC", className: "Player", index: 0, asKey: "player" },
            { op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" },
            { op: "captureViaGC", className: "Other", index: 0, asKey: "other" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(result.steps[0].ok).toBe(true);
        expect(result.steps[1].ok).toBe(false);
        expect(result.steps[1].error).toContain("boom");
        expect(result.steps[2].ok).toBe(true);
        expect(result.finalStatus).toBe("partial");
        expect(reg.get("player")).not.toBeNull();
        expect(reg.get("inv")).toBeNull();
        expect(reg.get("other")).not.toBeNull();
    });

    it("step referencing missing asKey errors structurally", async () => {
        const r = recipe([
            { op: "captureFieldValue", ownerKey: "doesnotexist", fieldName: "x", asKey: "y" },
        ]);
        const result = await replayRecipe(r, okAgent, reg);
        expect(result.steps[0].ok).toBe(false);
        expect(result.steps[0].error).toContain("doesnotexist");
        expect(result.finalStatus).toBe("failed");
    });

    it("finalStatus = failed when all steps fail", async () => {
        const agent: MockAgent = {
            ...okAgent,
            captureViaGC: async () => { throw new Error("nope"); },
        };
        const r = recipe([
            { op: "captureViaGC", className: "A", index: 0, asKey: "a" },
            { op: "captureViaGC", className: "B", index: 0, asKey: "b" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(result.finalStatus).toBe("failed");
    });
});
```

Run: `cd app && npx vitest run test/backend/core/instances/replay.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement**

Create `app/backend/core/instances/replay.ts`:

```typescript
import type { InstanceRegistry } from "./instance-registry";
import type { Recipe, RecipeStep, RecipeReplayResult, RecipeStepResult } from "./types";

export interface ReplayAgent {
    captureViaGC(className: string, index: number): Promise<{ className: string; handle: string }>;
    captureViaHook(className: string, tickMethod: string, timeoutMs: number): Promise<{ className: string; handle: string }>;
    captureFieldValue(ownerKey: string, fieldName: string, asKey: string): Promise<{ className: string; handle: string }>;
    captureListElement(listClassName: string, listFieldName: string, index: number, asKey: string): Promise<{ className: string; handle: string }>;
    captureMethodReturn(ownerKey: string, methodName: string, args: unknown[], asKey: string): Promise<{ className: string; handle: string }>;
}

export async function replayRecipe(
    recipe: Recipe,
    agent: ReplayAgent,
    registry: InstanceRegistry,
): Promise<RecipeReplayResult> {
    const steps: RecipeStepResult[] = [];

    for (let i = 0; i < recipe.steps.length; i++) {
        const step = recipe.steps[i];

        // Pre-check: chained steps must reference an existing asKey.
        if ("ownerKey" in step && !registry.get(step.ownerKey)) {
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: false,
                error: `referenced ownerKey "${step.ownerKey}" not found in registry`,
            });
            continue;
        }

        try {
            let result: { className: string; handle: string };
            switch (step.op) {
                case "captureViaGC":
                    result = await agent.captureViaGC(step.className, step.index);
                    break;
                case "captureViaHook":
                    result = await agent.captureViaHook(step.className, step.tickMethod, step.timeoutMs);
                    break;
                case "captureFieldValue":
                    result = await agent.captureFieldValue(step.ownerKey, step.fieldName, step.asKey);
                    break;
                case "captureListElement":
                    result = await agent.captureListElement(step.ownerKey, step.listFieldName, step.index, step.asKey);
                    break;
                case "captureMethodReturn":
                    result = await agent.captureMethodReturn(step.ownerKey, step.methodName, step.args, step.asKey);
                    break;
            }
            registry.set(step.asKey, result.className, result.handle, step.op);
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: true,
                summary: `${result.className}@${result.handle}`,
            });
        } catch (err) {
            steps.push({
                stepIndex: i, op: step.op, asKey: step.asKey, ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const okCount = steps.filter((s) => s.ok).length;
    const finalStatus: RecipeReplayResult["finalStatus"] =
        okCount === steps.length ? "ok"
      : okCount === 0            ? "failed"
                                 : "partial";
    return { steps, finalStatus };
}
```

NOTE: `RecipeStep` for `captureListElement` uses `ownerKey` (not `listClassName`), so the `"ownerKey" in step` pre-check covers it correctly — no special-casing needed.

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/core/instances/replay.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 4: Commit**

```bash
git add app/backend/core/instances/replay.ts app/test/backend/core/instances/replay.test.ts
git commit -m "feat(instances): replayRecipe engine — best-effort sequential execution"
```

---

## Task 6: Agent — `readAllFieldsStructured` returns `FieldRead[]`

**Files:**
- Modify: `src/rpc-agent/instance-ops.ts` (append new function)

The legacy `readAllFields(className)` returns `string[]` (formatted lines). The frontend needs structured data (`FieldRead[]`). Add a new function next to it without removing the legacy one.

- [ ] **Step 1: Append `readAllFieldsStructured`**

In `src/rpc-agent/instance-ops.ts`, append BEFORE the `writeField` function (around line 213):

```typescript
/**
 * Structured version of readAllFields — returns one entry per non-static field
 * with kind classification, preview, and rawValue for round-trip writes.
 * Used by the v1.4 Instances UI.
 */
export interface AgentFieldRead {
    name: string;
    typeName: string;
    kind: "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

export function readAllFieldsStructured(className: string): Promise<AgentFieldRead[]> {
    return inVm(() => {
        const inst = getCaptured(className);
        const out: AgentFieldRead[] = [];
        for (const f of inst.class.fields) {
            if (f.isStatic) continue;
            const name = f.name as string;
            const typeName = (f.type?.name ?? "?") as string;
            let isEnum = false;
            try { isEnum = (f.type as any)?.class?.parent?.name === "Enum"; } catch {}
            const isWritable = !((f as any).isLiteral === true);  // const fields not writable

            try {
                const v = inst.field(name).value;
                if (v === null || v === undefined) {
                    out.push({ name, typeName, kind: "null", preview: "null", isWritable });
                } else if (typeof v === "string") {
                    out.push({ name, typeName, kind: "string", preview: JSON.stringify(v), rawValue: v, isWritable });
                } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                    out.push({
                        name, typeName,
                        kind: isEnum ? "enum" : "scalar",
                        preview: String(v),
                        rawValue: typeof v === "bigint" ? v.toString() : v,
                        enumNumeric: isEnum && typeof v === "number" ? v : undefined,
                        isWritable,
                    });
                } else if (isEnum && (v as any).field) {
                    // Boxed enum object — extract value__ for the underlying integer.
                    let underlying: number | undefined = undefined;
                    try { underlying = Number((v as any).field("value__").value); } catch {}
                    out.push({
                        name, typeName, kind: "enum",
                        preview: underlying !== undefined ? String(underlying) : String(v),
                        rawValue: underlying,
                        enumNumeric: underlying,
                        isWritable,
                    });
                } else if ((v as any).class) {
                    const cn = String((v as any).class.name);
                    if (cn.startsWith("RepeatedField") || cn.startsWith("List") || cn.includes("[]")) {
                        let count = 0;
                        try { count = Number((v as any).method("get_Count").invoke()); } catch {}
                        out.push({ name, typeName, kind: "array", preview: `[${count} items]`, arrayLength: count, isWritable: false });
                    } else {
                        out.push({ name, typeName, kind: "nested", preview: `→ ${cn}`, nestedClass: cn, isWritable: false });
                    }
                } else {
                    out.push({ name, typeName, kind: "unknown", preview: String(v), isWritable });
                }
            } catch (err) {
                const msg = String(err);
                if (msg.includes("access violation") && msg.includes("0x0")) {
                    out.push({ name, typeName, kind: "null", preview: "null", isWritable });
                } else {
                    out.push({ name, typeName, kind: "unknown", preview: `<err: ${msg.slice(0, 80)}>`, isWritable: false });
                }
            }
        }
        return out;
    });
}
```

- [ ] **Step 2: Build the agent**

Run: `npm run build:rpc`
Expected: PASS (no errors). The new function is automatically picked up by `instanceOpsRpc` (re-exports `* as instanceOpsRpc`).

- [ ] **Step 3: Run all backend tests (sanity, no test for agent itself)**

Run: `cd app && npx vitest run test/backend`
Expected: PASS — no regression on the v1.3 baseline.

- [ ] **Step 4: Commit**

```bash
git add src/rpc-agent/instance-ops.ts
git commit -m "feat(instances): agent readAllFieldsStructured — typed FieldRead output"
```

---

## Task 7: Routes part 1 — list, capture, delete instance + tests

**Files:**
- Create: `app/backend/routes/instances.ts` (initial — with 3 endpoints)
- Test: `app/test/backend/routes-instances.test.ts` (initial)

- [ ] **Step 1: Write failing tests**

Create `app/test/backend/routes-instances.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mountInstances } from "../../backend/routes/instances.js";
import { InstanceRegistry } from "../../backend/core/instances/instance-registry.js";
import { HistoryStore } from "../../backend/core/instances/history-store.js";
import { RecipeStore } from "../../backend/core/instances/recipe-store.js";
import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";

interface AgentMock {
    [k: string]: (...args: any[]) => Promise<any>;
}

function buildApp(opts: { agent?: AgentMock; readOnly?: boolean } = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "routes-instances-"));
    const registry = new InstanceRegistry();
    const history = new HistoryStore();
    const storage = new DiskPluginStorage(tmpDir, "instances");
    const recipes = new RecipeStore(storage);
    let readOnly = opts.readOnly ?? true;
    const session: any = {
        instanceRegistry: () => registry,
        historyStore: () => history,
        recipeStore: () => recipes,
        agentCall: async (method: string, args: unknown[]) => {
            const fn = opts.agent?.[method];
            if (!fn) throw new Error(`agent mock missing: ${method}`);
            return fn(...(args ?? []));
        },
        getReadOnly: () => readOnly,
        setReadOnly: (v: boolean) => { readOnly = v; },
        emit: () => {},
    };
    const app = express();
    app.use(express.json());
    mountInstances(app, { session });
    return { app, registry, history, recipes, session };
}

describe("instances routes — list / capture / delete", () => {
    it("GET /api/instances/list returns the registry", async () => {
        const { app, registry } = buildApp();
        registry.set("player", "Player", "0x1", "captureViaGC");
        const res = await request(app).get("/api/instances/list");
        expect(res.status).toBe(200);
        expect(res.body.instances).toHaveLength(1);
        expect(res.body.instances[0].key).toBe("player");
    });

    it("POST /api/instances/capture (via GC) calls agent and stores in registry", async () => {
        const { app, registry } = buildApp({
            agent: { captureViaGC: async (className: string, index: number) => `${className}@0xABC[${index}]` },
        });
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureViaGC", className: "Player", index: 0, asKey: "player" });
        expect(res.status).toBe(200);
        expect(res.body.key).toBe("player");
        expect(registry.get("player")).not.toBeNull();
    });

    it("POST /api/instances/capture (via Hook) calls agent.capture", async () => {
        const { app, registry } = buildApp({
            agent: { capture: async (className: string, tickMethod: string) => `${className}@0xHK_${tickMethod}` },
        });
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureViaHook", className: "Player", tickMethod: "Update", timeoutMs: 5000, asKey: "p" });
        expect(res.status).toBe(200);
        expect(registry.get("p")).not.toBeNull();
    });

    it("POST /api/instances/capture (chain field) calls agent and stores", async () => {
        const { app, registry } = buildApp({
            agent: { captureFieldValue: async () => "Inv@0xFV" },
        });
        registry.set("player", "Player", "0x1", "captureViaGC");
        const res = await request(app)
            .post("/api/instances/capture")
            .send({ op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" });
        expect(res.status).toBe(200);
        expect(registry.get("inv")).not.toBeNull();
    });

    it("POST /api/instances/capture rejects unknown op with 400", async () => {
        const { app } = buildApp();
        const res = await request(app).post("/api/instances/capture").send({ op: "wat" });
        expect(res.status).toBe(400);
    });

    it("DELETE /api/instances/:key removes from registry", async () => {
        const { app, registry } = buildApp();
        registry.set("p", "P", "0x1", "captureViaGC");
        const res = await request(app).delete("/api/instances/p");
        expect(res.status).toBe(200);
        expect(registry.get("p")).toBeNull();
    });

    it("DELETE /api/instances/:key returns 404 for missing key", async () => {
        const { app } = buildApp();
        const res = await request(app).delete("/api/instances/missing");
        expect(res.status).toBe(404);
    });
});
```

Run: `cd app && npx vitest run test/backend/routes-instances.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement initial routes**

Create `app/backend/routes/instances.ts`:

```typescript
import type { Express } from "express";

export interface InstancesDeps {
    session: {
        instanceRegistry: () => import("../core/instances/instance-registry.js").InstanceRegistry | null;
        historyStore: () => import("../core/instances/history-store.js").HistoryStore | null;
        recipeStore: () => import("../core/instances/recipe-store.js").RecipeStore | null;
        agentCall: (method: string, args: unknown[]) => Promise<unknown>;
        getReadOnly: () => boolean;
        setReadOnly: (v: boolean) => void;
        emit: (event: string, ...args: unknown[]) => boolean;
    };
}

// Parse "ClassName@0xHANDLE" → { className, handle }. Falls back to ("Unknown", raw).
function parseAgentSummary(raw: string): { className: string; handle: string } {
    const m = raw.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
    if (m) return { className: m[1], handle: m[2] };
    return { className: "Unknown", handle: raw };
}

export function mountInstances(app: Express, deps: InstancesDeps): void {
    app.get("/api/instances/list", (_req, res) => {
        const reg = deps.session.instanceRegistry();
        res.json({ instances: reg ? reg.list() : [] });
    });

    app.post("/api/instances/capture", async (req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "no session" }); return; }
        const body = req.body ?? {};
        const op = body.op;
        try {
            let summary: string;
            switch (op) {
                case "captureViaGC":
                    summary = String(await deps.session.agentCall("captureViaGC", [body.className, body.index]));
                    break;
                case "captureViaHook":
                    summary = String(await deps.session.agentCall("capture", [body.className, body.tickMethod, body.timeoutMs]));
                    break;
                case "captureFieldValue":
                    summary = String(await deps.session.agentCall("captureFieldValue", [body.ownerKey, body.fieldName, body.asKey]));
                    break;
                case "captureListElement":
                    summary = String(await deps.session.agentCall("captureListElement", [body.ownerKey, body.listFieldName, body.index, body.asKey]));
                    break;
                case "captureMethodReturn":
                    summary = String(await deps.session.agentCall("captureMethodReturn", [body.ownerKey, body.methodName, body.args ?? [], body.asKey]));
                    break;
                default:
                    res.status(400).json({ error: `unknown op: ${op}` });
                    return;
            }
            const { className, handle } = parseAgentSummary(summary);
            reg.set(body.asKey, className, handle, op);
            deps.session.emit("instance-registry-changed");
            res.json({ key: body.asKey, summary });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.delete("/api/instances/:key", (req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "no session" }); return; }
        if (!reg.get(req.params.key)) { res.status(404).json({ error: "not found" }); return; }
        reg.delete(req.params.key);
        deps.session.emit("instance-registry-changed");
        res.json({ ok: true });
    });
}
```

NOTE: The agent legacy `capture` returns a string like `"Player@0x1234"` (regex parse). `captureViaGC` returns the same shape. Other capture functions return `"ClassName@handle"` similarly per the legacy code we read. The `parseAgentSummary` helper handles both.

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/routes-instances.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/instances.ts app/test/backend/routes-instances.test.ts
git commit -m "feat(instances): routes part 1 — list/capture/delete"
```

---

## Task 8: Routes part 2 — read-fields, write-field, call + tests

**Files:**
- Modify: `app/backend/routes/instances.ts` (add 3 endpoints)
- Test: `app/test/backend/routes-instances.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `app/test/backend/routes-instances.test.ts`:

```typescript
describe("instances routes — read / write / call", () => {
    it("POST /api/instances/:key/read-fields returns FieldRead[]", async () => {
        const { app, registry } = buildApp({
            agent: {
                readAllFieldsStructured: async () => [
                    { name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true },
                    { name: "name",   typeName: "String", kind: "string", preview: '"foo"', rawValue: "foo", isWritable: true },
                ],
            },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/read-fields");
        expect(res.status).toBe(200);
        expect(res.body.alive).toBe(true);
        expect(res.body.fields).toHaveLength(2);
    });

    it("POST /api/instances/:key/read-fields → 404 if key missing", async () => {
        const { app } = buildApp();
        const res = await request(app).post("/api/instances/missing/read-fields");
        expect(res.status).toBe(404);
    });

    it("POST /api/instances/:key/write-field requires Read-Only OFF", async () => {
        const { app, registry } = buildApp({ readOnly: true });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/write-field").send({ fieldName: "health", value: 9999 });
        expect(res.status).toBe(403);
    });

    it("POST /api/instances/:key/write-field happy path snapshots before/after + history", async () => {
        const reads: any[] = [];
        const { app, registry, history } = buildApp({
            readOnly: false,
            agent: {
                readField: async (_k: string, fieldName: string) => { reads.push(fieldName); return reads.length === 1 ? "100" : "9999"; },
                writeField: async () => "9999",
            },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/write-field").send({ fieldName: "health", value: 9999 });
        expect(res.status).toBe(200);
        expect(res.body.before).toBe("100");
        expect(res.body.after).toBe("9999");
        const entries = history.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].action).toBe("write");
        expect(entries[0].before).toBe("100");
        expect(entries[0].after).toBe("9999");
    });

    it("POST /api/instances/:key/call requires Read-Only OFF", async () => {
        const { app, registry } = buildApp({ readOnly: true });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/call").send({ methodName: "Heal", args: [] });
        expect(res.status).toBe(403);
    });

    it("POST /api/instances/:key/call happy path returns result + history entry", async () => {
        const { app, registry, history } = buildApp({
            readOnly: false,
            agent: { callInstance: async () => "void" },
        });
        registry.set("p", "Player", "0x1", "captureViaGC");
        const res = await request(app).post("/api/instances/p/call").send({ methodName: "Heal", args: [] });
        expect(res.status).toBe(200);
        expect(res.body.result).toBe("void");
        const entries = history.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].action).toBe("call");
        expect(entries[0].callResult).toBe("void");
    });
});
```

- [ ] **Step 2: Implement endpoints**

In `app/backend/routes/instances.ts`, add to the `mountInstances` function (before the closing brace):

```typescript
import { randomUUID } from "node:crypto";
```

Add at the top of the file, then inside `mountInstances`:

```typescript
app.post("/api/instances/:key/read-fields", async (req, res) => {
    const reg = deps.session.instanceRegistry();
    if (!reg) { res.status(503).json({ error: "no session" }); return; }
    const inst = reg.get(req.params.key);
    if (!inst) { res.status(404).json({ error: "not found" }); return; }
    try {
        const fields = await deps.session.agentCall("readAllFieldsStructured", [req.params.key]);
        // If we got here without throwing, the instance is alive.
        if (!inst.isAlive) reg.setAlive(req.params.key, true);
        res.json({ alive: true, fields });
    } catch (err) {
        reg.setAlive(req.params.key, false);
        res.json({ alive: false, fields: [], error: err instanceof Error ? err.message : String(err) });
    }
});

app.post("/api/instances/:key/write-field", async (req, res) => {
    const reg = deps.session.instanceRegistry();
    const hist = deps.session.historyStore();
    if (!reg || !hist) { res.status(503).json({ error: "no session" }); return; }
    if (deps.session.getReadOnly()) { res.status(403).json({ error: "read-only mode active" }); return; }
    const inst = reg.get(req.params.key);
    if (!inst) { res.status(404).json({ error: "not found" }); return; }
    const { fieldName, value } = req.body ?? {};
    if (typeof fieldName !== "string") { res.status(400).json({ error: "fieldName required" }); return; }

    let before = "?";
    let after = "?";
    let success = false;
    let errorMsg: string | undefined;
    try {
        before = String(await deps.session.agentCall("readField", [req.params.key, fieldName]));
        await deps.session.agentCall("writeField", [req.params.key, fieldName, value]);
        after = String(await deps.session.agentCall("readField", [req.params.key, fieldName]));
        success = true;
    } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
    }

    hist.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        action: "write",
        target: { instanceKey: req.params.key, member: fieldName },
        before, after, success, error: errorMsg,
    });
    deps.session.emit("instance-history-changed");

    if (!success) { res.status(500).json({ error: errorMsg }); return; }
    res.json({ before, after });
});

app.post("/api/instances/:key/call", async (req, res) => {
    const reg = deps.session.instanceRegistry();
    const hist = deps.session.historyStore();
    if (!reg || !hist) { res.status(503).json({ error: "no session" }); return; }
    if (deps.session.getReadOnly()) { res.status(403).json({ error: "read-only mode active" }); return; }
    const inst = reg.get(req.params.key);
    if (!inst) { res.status(404).json({ error: "not found" }); return; }
    const { methodName, args } = req.body ?? {};
    if (typeof methodName !== "string") { res.status(400).json({ error: "methodName required" }); return; }

    let callResult = "?";
    let success = false;
    let errorMsg: string | undefined;
    try {
        callResult = String(await deps.session.agentCall("callInstance", [req.params.key, methodName, args ?? []]));
        success = true;
    } catch (err) {
        errorMsg = err instanceof Error ? err.message : String(err);
    }

    hist.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        action: "call",
        target: { instanceKey: req.params.key, member: methodName },
        callArgs: args ?? [],
        callResult,
        success,
        error: errorMsg,
    });
    deps.session.emit("instance-history-changed");

    if (!success) { res.status(500).json({ error: errorMsg }); return; }
    res.json({ result: callResult });
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/routes-instances.test.ts`
Expected: PASS — 13 tests total (7 + 6 new).

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/instances.ts app/test/backend/routes-instances.test.ts
git commit -m "feat(instances): routes part 2 — read-fields/write-field/call + history"
```

---

## Task 9: Routes part 3 — read-only toggle, recipes CRUD + tests

**Files:**
- Modify: `app/backend/routes/instances.ts`
- Test: `app/test/backend/routes-instances.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `app/test/backend/routes-instances.test.ts`:

```typescript
describe("instances routes — read-only toggle", () => {
    it("GET /api/instances/read-only returns current state", async () => {
        const { app } = buildApp({ readOnly: true });
        const res = await request(app).get("/api/instances/read-only");
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(true);
    });

    it("POST /api/instances/read-only flips the flag", async () => {
        const { app, session } = buildApp({ readOnly: true });
        const res = await request(app).post("/api/instances/read-only").send({ enabled: false });
        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
        expect(session.getReadOnly()).toBe(false);
    });
});

describe("instances routes — recipes CRUD", () => {
    const sampleSteps = [
        { op: "captureViaGC", className: "Player", index: 0, asKey: "p" },
    ];

    it("GET /api/instances/recipes returns all", async () => {
        const { app, recipes } = buildApp();
        recipes.add("a", sampleSteps as any);
        recipes.add("b", sampleSteps as any);
        const res = await request(app).get("/api/instances/recipes");
        expect(res.body.recipes).toHaveLength(2);
    });

    it("POST /api/instances/recipes creates a recipe", async () => {
        const { app, recipes } = buildApp();
        const res = await request(app).post("/api/instances/recipes").send({ name: "test", steps: sampleSteps });
        expect(res.status).toBe(200);
        expect(res.body.recipe.id).toBeDefined();
        expect(recipes.list()).toHaveLength(1);
    });

    it("PUT /api/instances/recipes/:id updates a recipe", async () => {
        const { app, recipes } = buildApp();
        const r = recipes.add("a", sampleSteps as any);
        const res = await request(app).put(`/api/instances/recipes/${r.id}`).send({ name: "renamed" });
        expect(res.status).toBe(200);
        expect(recipes.get(r.id)?.name).toBe("renamed");
    });

    it("DELETE /api/instances/recipes/:id removes it", async () => {
        const { app, recipes } = buildApp();
        const r = recipes.add("a", sampleSteps as any);
        const res = await request(app).delete(`/api/instances/recipes/${r.id}`);
        expect(res.status).toBe(200);
        expect(recipes.list()).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Implement endpoints**

In `app/backend/routes/instances.ts`, add inside `mountInstances`:

```typescript
app.get("/api/instances/read-only", (_req, res) => {
    res.json({ enabled: deps.session.getReadOnly() });
});

app.post("/api/instances/read-only", (req, res) => {
    const enabled = !!(req.body?.enabled);
    deps.session.setReadOnly(enabled);
    deps.session.emit("read-only-changed");
    res.json({ enabled });
});

app.get("/api/instances/recipes", (_req, res) => {
    const rs = deps.session.recipeStore();
    res.json({ recipes: rs ? rs.list() : [] });
});

app.post("/api/instances/recipes", (req, res) => {
    const rs = deps.session.recipeStore();
    if (!rs) { res.status(503).json({ error: "no session" }); return; }
    const { name, steps, description } = req.body ?? {};
    if (typeof name !== "string" || !Array.isArray(steps)) {
        res.status(400).json({ error: "name (string) + steps (array) required" });
        return;
    }
    const recipe = rs.add(name, steps, description);
    deps.session.emit("recipe-store-changed");
    res.json({ recipe });
});

app.put("/api/instances/recipes/:id", (req, res) => {
    const rs = deps.session.recipeStore();
    if (!rs) { res.status(503).json({ error: "no session" }); return; }
    if (!rs.get(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
    rs.update(req.params.id, req.body ?? {});
    deps.session.emit("recipe-store-changed");
    res.json({ recipe: rs.get(req.params.id) });
});

app.delete("/api/instances/recipes/:id", (req, res) => {
    const rs = deps.session.recipeStore();
    if (!rs) { res.status(503).json({ error: "no session" }); return; }
    if (!rs.get(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
    rs.delete(req.params.id);
    deps.session.emit("recipe-store-changed");
    res.json({ ok: true });
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/routes-instances.test.ts`
Expected: PASS — 19 tests total.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/instances.ts app/test/backend/routes-instances.test.ts
git commit -m "feat(instances): routes part 3 — read-only toggle + recipes CRUD"
```

---

## Task 10: Routes part 4 — recipe replay + history endpoints + tests

**Files:**
- Modify: `app/backend/routes/instances.ts`
- Test: `app/test/backend/routes-instances.test.ts` (append)

- [ ] **Step 1: Write failing tests**

Append to `app/test/backend/routes-instances.test.ts`:

```typescript
describe("instances routes — recipe replay", () => {
    it("POST /api/instances/recipes/:id/replay executes all steps", async () => {
        const { app, recipes, registry } = buildApp({
            agent: {
                captureViaGC: async (cn: string) => `${cn}@0x1`,
                captureFieldValue: async () => "Inv@0x2",
            },
        });
        const r = recipes.add("test", [
            { op: "captureViaGC", className: "Player", index: 0, asKey: "p" },
            { op: "captureFieldValue", ownerKey: "p", fieldName: "inv", asKey: "i" },
        ] as any);
        const res = await request(app).post(`/api/instances/recipes/${r.id}/replay`);
        expect(res.status).toBe(200);
        expect(res.body.finalStatus).toBe("ok");
        expect(res.body.steps).toHaveLength(2);
        expect(registry.get("p")).not.toBeNull();
        expect(registry.get("i")).not.toBeNull();
    });

    it("POST /api/instances/recipes/:id/replay returns 404 for unknown id", async () => {
        const { app } = buildApp();
        const res = await request(app).post("/api/instances/recipes/missing/replay");
        expect(res.status).toBe(404);
    });
});

describe("instances routes — history", () => {
    it("GET /api/instances/history returns entries (most recent first)", async () => {
        const { app, history } = buildApp();
        history.append({ id: "1", timestamp: "2026-05-07T00:00:00Z", action: "write", target: { instanceKey: "p", member: "x" }, before: "1", after: "2", success: true });
        const res = await request(app).get("/api/instances/history");
        expect(res.status).toBe(200);
        expect(res.body.entries).toHaveLength(1);
    });

    it("DELETE /api/instances/history clears", async () => {
        const { app, history } = buildApp();
        history.append({ id: "1", timestamp: "2026-05-07T00:00:00Z", action: "write", target: { instanceKey: "p", member: "x" }, before: "1", after: "2", success: true });
        const res = await request(app).delete("/api/instances/history");
        expect(res.status).toBe(200);
        expect(history.list()).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Implement endpoints**

In `app/backend/routes/instances.ts`, add at the top:

```typescript
import { replayRecipe, type ReplayAgent } from "../core/instances/replay.js";
```

Then inside `mountInstances`:

```typescript
app.post("/api/instances/recipes/:id/replay", async (req, res) => {
    const rs = deps.session.recipeStore();
    const reg = deps.session.instanceRegistry();
    if (!rs || !reg) { res.status(503).json({ error: "no session" }); return; }
    const recipe = rs.get(req.params.id);
    if (!recipe) { res.status(404).json({ error: "not found" }); return; }

    // Build a ReplayAgent that calls deps.session.agentCall and parses summaries.
    const parse = (raw: string): { className: string; handle: string } => {
        const m = raw.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
        return m ? { className: m[1], handle: m[2] } : { className: "Unknown", handle: raw };
    };
    const agent: ReplayAgent = {
        captureViaGC: async (cn, idx) => parse(String(await deps.session.agentCall("captureViaGC", [cn, idx]))),
        captureViaHook: async (cn, tm, ms) => parse(String(await deps.session.agentCall("capture", [cn, tm, ms]))),
        captureFieldValue: async (ok, fn, ak) => parse(String(await deps.session.agentCall("captureFieldValue", [ok, fn, ak]))),
        captureListElement: async (cn, fn, idx, ak) => parse(String(await deps.session.agentCall("captureListElement", [cn, fn, idx, ak]))),
        captureMethodReturn: async (ok, mn, args, ak) => parse(String(await deps.session.agentCall("captureMethodReturn", [ok, mn, args, ak]))),
    };

    const result = await replayRecipe(recipe, agent, reg);
    rs.update(recipe.id, {
        lastReplayedAt: new Date().toISOString(),
        lastReplayStatus: result.finalStatus,
    });
    deps.session.emit("instance-registry-changed");
    deps.session.emit("recipe-store-changed");
    res.json(result);
});

app.get("/api/instances/history", (_req, res) => {
    const h = deps.session.historyStore();
    res.json({ entries: h ? h.list() : [] });
});

app.delete("/api/instances/history", (_req, res) => {
    const h = deps.session.historyStore();
    if (!h) { res.status(503).json({ error: "no session" }); return; }
    h.clear();
    deps.session.emit("instance-history-changed");
    res.json({ ok: true });
});
```

- [ ] **Step 3: Run tests**

Run: `cd app && npx vitest run test/backend/routes-instances.test.ts`
Expected: PASS — ~23 tests total.

- [ ] **Step 4: Commit**

```bash
git add app/backend/routes/instances.ts app/test/backend/routes-instances.test.ts
git commit -m "feat(instances): routes part 4 — recipe replay + history endpoints"
```

---

## Task 11: Session wiring + WS bridge

**Files:**
- Modify: `app/backend/session.ts`
- Modify: `app/backend/ws-bridge.ts`
- Modify: `app/backend/routes.ts` (or wherever routes are mounted at server startup — find via `grep mountHooks app/backend`)

- [ ] **Step 1: Find the route mounting point**

Run: `grep -n "mountHooks\|mountNetwork\|mountMigrations" app/backend/*.ts`

Expected: a single file (likely `app/backend/server.ts` or `app/backend/routes.ts`) that mounts all routes. Note its location for Step 3.

- [ ] **Step 2: Add stores to Session**

In `app/backend/session.ts`:

(a) Update imports — add:

```typescript
import { InstanceRegistry } from "./core/instances/instance-registry.js";
import { HistoryStore } from "./core/instances/history-store.js";
import { RecipeStore } from "./core/instances/recipe-store.js";
```

(b) Add three new fields next to the existing `currentHookStore` etc:

```typescript
private currentInstanceRegistry: InstanceRegistry | null = null;
private currentHistoryStore: HistoryStore | null = null;
private currentRecipeStore: RecipeStore | null = null;
private instancesReadOnly = true;
```

(c) Add three accessor methods next to `hookStore()` / `frameStore()`:

```typescript
instanceRegistry(): InstanceRegistry | null { return this.currentInstanceRegistry; }
historyStore(): HistoryStore | null { return this.currentHistoryStore; }
recipeStore(): RecipeStore | null { return this.currentRecipeStore; }
getReadOnly(): boolean { return this.instancesReadOnly; }
setReadOnly(v: boolean): void { this.instancesReadOnly = v; }

async agentCall(method: string, args: unknown[]): Promise<unknown> {
    return this.fridaClient.call(method, args);
}
```

(d) In `_doAttach`, after the existing FrameStore/SerializerConfig wiring, add:

```typescript
this.currentInstanceRegistry = new InstanceRegistry();
this.currentHistoryStore = new HistoryStore();
const instancesStorage = new DiskPluginStorage(profile.rootPath, "instances");
this.currentRecipeStore = new RecipeStore(instancesStorage);
this.instancesReadOnly = true;  // safe default at every attach

this.disposeListeners.push(
    this.currentInstanceRegistry.onChange(() => this.emit("instance-registry-changed")),
);
this.disposeListeners.push(
    this.currentHistoryStore.onChange(() => this.emit("instance-history-changed")),
);
this.disposeListeners.push(
    this.currentRecipeStore.onChange(() => this.emit("recipe-store-changed")),
);
```

(e) In `handleDetach`, add to the clearing logic:

```typescript
this.currentInstanceRegistry = null;
this.currentHistoryStore = null;
this.currentRecipeStore = null;
this.instancesReadOnly = true;
```

- [ ] **Step 3: Wire ws-bridge**

In `app/backend/ws-bridge.ts`, near the existing `migration-updated` listener, add:

```typescript
session.on("instance-registry-changed", () => broadcast({ type: "instance-registry-changed" }));
session.on("instance-history-changed", () => broadcast({ type: "instance-history-changed" }));
session.on("recipe-store-changed", () => broadcast({ type: "recipe-store-changed" }));
session.on("read-only-changed", () => broadcast({ type: "read-only-changed", enabled: session.getReadOnly() }));
```

- [ ] **Step 4: Mount the routes**

Wherever existing routes are mounted (from Step 1), add:

```typescript
import { mountInstances } from "./routes/instances.js";
// ...
mountInstances(app, { session });
```

- [ ] **Step 5: Run all backend tests**

Run: `cd app && npx vitest run test/backend`
Expected: PASS — no regression on the 191+ baseline.

- [ ] **Step 6: Typecheck + build**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add app/backend/session.ts app/backend/ws-bridge.ts app/backend/routes.ts app/backend/server.ts 2>/dev/null
git commit -m "feat(instances): wire stores into Session + WS bridge + route mount"
```

(Adjust `git add` to match the actual files modified.)

---

## Task 12: Frontend types + api

**Files:**
- Modify: `app/frontend/core/types.ts` (add Instance types)
- Modify: `app/frontend/core/api.ts` (add Instance methods)

- [ ] **Step 1: Add types to `app/frontend/core/types.ts`**

Append to `app/frontend/core/types.ts`:

```typescript
// ---------------------------------------------------------------------------
// v1.4 Instances plugin
// ---------------------------------------------------------------------------

export type InstanceRecipeStep =
    | { op: "captureViaGC"; className: string; index: number; asKey: string }
    | { op: "captureViaHook"; className: string; tickMethod: string; timeoutMs: number; asKey: string }
    | { op: "captureFieldValue"; ownerKey: string; fieldName: string; asKey: string }
    | { op: "captureListElement"; ownerKey: string; listFieldName: string; index: number; asKey: string }
    | { op: "captureMethodReturn"; ownerKey: string; methodName: string; args: unknown[]; asKey: string };

export interface InstanceRecipe {
    id: string;
    name: string;
    description?: string;
    steps: InstanceRecipeStep[];
    createdAt: string;
    updatedAt: string;
    lastReplayedAt?: string;
    lastReplayStatus?: "ok" | "partial" | "failed";
}

export interface CapturedInstanceLite {
    key: string;
    className: string;
    handle: string;
    capturedAt: string;
    capturedVia: InstanceRecipeStep["op"];
    isAlive: boolean;
}

export interface FieldReadLite {
    name: string;
    typeName: string;
    kind: "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

export interface InstanceHistoryEntry {
    id: string;
    timestamp: string;
    action: "write" | "call";
    target: { instanceKey: string; member: string };
    before?: string;
    after?: string;
    callArgs?: unknown[];
    callResult?: string;
    success: boolean;
    error?: string;
}

export interface InstanceRecipeStepResult {
    stepIndex: number;
    op: InstanceRecipeStep["op"];
    asKey: string;
    ok: boolean;
    summary?: string;
    error?: string;
}

export interface InstanceRecipeReplayResult {
    steps: InstanceRecipeStepResult[];
    finalStatus: "ok" | "partial" | "failed";
}
```

- [ ] **Step 2: Add API methods to `app/frontend/core/api.ts`**

In `app/frontend/core/api.ts`, add the following methods inside the `api = { ... }` object (after the migration methods):

```typescript
// ---- v1.4 Instances ----
listInstances() {
    return call<{ instances: import("./types.js").CapturedInstanceLite[] }>("GET", "/api/instances/list");
},
captureInstance(payload: import("./types.js").InstanceRecipeStep) {
    return call<{ key: string; summary: string }>("POST", "/api/instances/capture", payload);
},
deleteInstance(key: string) {
    return call<{ ok: boolean }>("DELETE", `/api/instances/${encodeURIComponent(key)}`);
},
readInstanceFields(key: string) {
    return call<{ alive: boolean; fields: import("./types.js").FieldReadLite[]; error?: string }>(
        "POST", `/api/instances/${encodeURIComponent(key)}/read-fields`,
    );
},
writeInstanceField(key: string, fieldName: string, value: unknown) {
    return call<{ before: string; after: string }>(
        "POST", `/api/instances/${encodeURIComponent(key)}/write-field`, { fieldName, value },
    );
},
callInstanceMethod(key: string, methodName: string, args: unknown[]) {
    return call<{ result: string }>(
        "POST", `/api/instances/${encodeURIComponent(key)}/call`, { methodName, args },
    );
},
getInstancesReadOnly() {
    return call<{ enabled: boolean }>("GET", "/api/instances/read-only");
},
setInstancesReadOnly(enabled: boolean) {
    return call<{ enabled: boolean }>("POST", "/api/instances/read-only", { enabled });
},
listRecipes() {
    return call<{ recipes: import("./types.js").InstanceRecipe[] }>("GET", "/api/instances/recipes");
},
addRecipe(name: string, steps: import("./types.js").InstanceRecipeStep[], description?: string) {
    return call<{ recipe: import("./types.js").InstanceRecipe }>(
        "POST", "/api/instances/recipes", { name, steps, description },
    );
},
updateRecipe(id: string, patch: Partial<import("./types.js").InstanceRecipe>) {
    return call<{ recipe: import("./types.js").InstanceRecipe }>(
        "PUT", `/api/instances/recipes/${encodeURIComponent(id)}`, patch,
    );
},
deleteRecipe(id: string) {
    return call<{ ok: boolean }>("DELETE", `/api/instances/recipes/${encodeURIComponent(id)}`);
},
replayRecipe(id: string) {
    return call<import("./types.js").InstanceRecipeReplayResult>(
        "POST", `/api/instances/recipes/${encodeURIComponent(id)}/replay`,
    );
},
getInstanceHistory() {
    return call<{ entries: import("./types.js").InstanceHistoryEntry[] }>("GET", "/api/instances/history");
},
clearInstanceHistory() {
    return call<{ ok: boolean }>("DELETE", "/api/instances/history");
},
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc -p tsconfig.frontend.json --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/core/types.ts app/frontend/core/api.ts
git commit -m "feat(instances): frontend types + api client for v1.4 endpoints"
```

---

## Task 13: Frontend page skeleton + sidebar

**Files:**
- Create: `app/frontend/pages/instances.ts`
- Modify: `app/frontend/router.ts` (or whatever wires the hash routing — find via grep)

- [ ] **Step 1: Find the router**

Run: `grep -rn "mountHooksPage\|mountMigrationsPage\|mountNetworkPage" app/frontend/`

Identify the file (likely `app/frontend/main.ts` or similar) that dispatches `location.hash` to page-mount functions.

- [ ] **Step 2: Create the page**

Create `app/frontend/pages/instances.ts`:

```typescript
// app/frontend/pages/instances.ts — v1.4 Instances plugin page
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";
import type { CapturedInstanceLite, FieldReadLite, InstanceHistoryEntry } from "../core/types.js";

let _hostEl: HTMLElement | null = null;
let _instances: CapturedInstanceLite[] = [];
let _activeKey: string | null = null;
let _activeFields: FieldReadLite[] = [];
let _activeAlive = true;
let _readOnly = true;
let _history: InstanceHistoryEntry[] = [];

export function mountInstancesPage(host: HTMLElement): void {
    _hostEl = host;
    host.style.flex = "1";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    void loadAll();
    subscribe("instance-registry-changed", () => { void loadInstances(); });
    subscribe("instance-history-changed", () => { void loadHistory(); });
    subscribe("read-only-changed", () => { void loadReadOnly(); });
    // Honor deep-link: #/instances?class=Foo opens the wizard pre-filled
    setTimeout(() => {
        const hash = window.location.hash;
        const m = hash.match(/[?&]class=([^&]+)/);
        if (m) {
            const className = decodeURIComponent(m[1]);
            // Defer to capture wizard modal (Task 17)
            window.dispatchEvent(new CustomEvent("instances:open-wizard", { detail: { className } }));
        }
    }, 0);
}

async function loadAll(): Promise<void> {
    await Promise.all([loadInstances(), loadHistory(), loadReadOnly()]);
    render();
}

async function loadInstances(): Promise<void> {
    try {
        const r = await api.listInstances();
        _instances = r.instances;
        if (_activeKey && !_instances.find((i) => i.key === _activeKey)) _activeKey = null;
        if (!_activeKey && _instances.length > 0) _activeKey = _instances[0].key;
        if (_activeKey) await loadActiveFields();
        render();
    } catch (e) { renderError(e); }
}

async function loadActiveFields(): Promise<void> {
    if (!_activeKey) { _activeFields = []; return; }
    try {
        const r = await api.readInstanceFields(_activeKey);
        _activeAlive = r.alive;
        _activeFields = r.fields;
    } catch { _activeFields = []; _activeAlive = false; }
}

async function loadHistory(): Promise<void> {
    try {
        const r = await api.getInstanceHistory();
        _history = r.entries;
        renderHistory();
    } catch { _history = []; }
}

async function loadReadOnly(): Promise<void> {
    try {
        const r = await api.getInstancesReadOnly();
        _readOnly = r.enabled;
        render();
    } catch { /* keep current value */ }
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderError(e: unknown): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `<div style="padding:14px;color:var(--danger)">${escape(String(e))}</div>`;
}

function render(): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `
        <style>
            .ip-toolbar { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--border-strong); background:var(--bg-elevated); }
            .ip-pill { padding:3px 8px; border-radius:3px; font-size:11px; cursor:pointer; border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-strong); display:inline-flex; align-items:center; gap:4px; }
            .ip-pill:hover { background:var(--bg-hover); }
            .ip-pill.active { background:var(--accent); color:var(--bg); }
            .ip-pill.danger { color:var(--danger); }
            .ip-body { flex:1; display:flex; overflow:hidden; }
            .ip-sidebar { width:300px; border-right:1px solid var(--border-strong); overflow-y:auto; background:var(--bg-elevated); }
            .ip-viewer { flex:1; overflow-y:auto; padding:12px; }
            .ip-history { width:320px; border-left:1px solid var(--border-strong); overflow-y:auto; background:var(--bg-elevated); }
            .ip-section-title { font-size:10px; color:var(--text-faint); padding:8px 12px; text-transform:uppercase; letter-spacing:0.05em; }
            .ip-instance { padding:6px 12px; cursor:pointer; border-bottom:1px solid var(--border-strong); }
            .ip-instance:hover { background:var(--bg-hover); }
            .ip-instance.active { background:rgba(99,102,241,0.12); border-left:2px solid var(--accent); padding-left:10px; }
            .ip-instance .key { font-weight:600; font-family:var(--font-code); font-size:12px; }
            .ip-instance .meta { font-size:10px; color:var(--text-faint); margin-top:2px; }
            .ip-instance.dead { opacity:0.5; }
            .ip-field-row { display:flex; align-items:baseline; gap:8px; padding:3px 0; font-family:var(--font-code); font-size:12px; }
            .ip-field-name { min-width:140px; color:var(--text-strong); }
            .ip-field-type { min-width:60px; color:var(--syntax-type); font-size:10px; }
            .ip-field-value { flex:1; color:var(--syntax-name); }
            .ip-input { background:var(--bg); border:1px solid var(--border-strong); color:var(--text-strong); font-family:var(--font-code); font-size:11px; padding:1px 4px; }
            .ip-history-row { padding:6px 12px; border-bottom:1px solid var(--border-strong); font-family:var(--font-code); font-size:11px; }
            .ip-history-tag { display:inline-block; padding:1px 5px; border-radius:3px; font-size:9px; font-weight:600; margin-right:6px; }
            .ip-history-tag.write { background:rgba(99,102,241,0.15); color:var(--accent); }
            .ip-history-tag.call { background:rgba(245,158,11,0.15); color:var(--warning); }
        </style>
        <div class="ip-toolbar">
            <button class="ip-pill" id="ip-new-capture">${icons.crosshair(12)} New capture</button>
            <button class="ip-pill" id="ip-recipes">${icons.folder(12)} Recipes</button>
            <button class="ip-pill ${_readOnly ? "active" : ""}" id="ip-toggle-ro">${_readOnly ? "🔒" : "🔓"} Read-Only</button>
            <button class="ip-pill" id="ip-refresh">${icons.refresh(12)} Refresh</button>
            <span style="flex:1"></span>
            <span style="color:var(--text-faint);font-size:11px">${_instances.length} captured · ${_history.length} history</span>
        </div>
        <div class="ip-body">
            <div class="ip-sidebar" id="ip-sidebar"></div>
            <div class="ip-viewer" id="ip-viewer"></div>
            <div class="ip-history" id="ip-history"></div>
        </div>
    `;
    renderSidebar();
    renderViewer();
    renderHistory();
    bindToolbar();
}

function renderSidebar(): void {
    if (!_hostEl) return;
    const sb = _hostEl.querySelector<HTMLElement>("#ip-sidebar");
    if (!sb) return;
    sb.innerHTML = `<div class="ip-section-title">Captured Instances (${_instances.length})</div>`;
    for (const inst of _instances) {
        const isActive = inst.key === _activeKey;
        const div = document.createElement("div");
        div.className = `ip-instance ${isActive ? "active" : ""} ${inst.isAlive ? "" : "dead"}`;
        div.innerHTML = `
            <div class="key">${escape(inst.key)}</div>
            <div class="meta">${escape(inst.className)}@${escape(inst.handle)} ${inst.isAlive ? "" : "(dead)"}</div>
        `;
        div.addEventListener("click", () => {
            _activeKey = inst.key;
            void loadActiveFields().then(render);
        });
        sb.appendChild(div);
    }
    if (_instances.length === 0) {
        sb.innerHTML += `<div style="padding:14px;color:var(--text-faint);font-size:11px;text-align:center">No captures yet.<br>Click "New capture" to start.</div>`;
    }
}

function renderViewer(): void {
    if (!_hostEl) return;
    const v = _hostEl.querySelector<HTMLElement>("#ip-viewer");
    if (!v) return;
    if (!_activeKey) {
        v.innerHTML = `<div style="color:var(--text-faint);padding:14px">Select a capture from the sidebar.</div>`;
        return;
    }
    const inst = _instances.find((i) => i.key === _activeKey);
    if (!inst) { v.innerHTML = ""; return; }
    v.innerHTML = `
        <h3 style="margin-top:0;font-family:var(--font-code);font-size:14px">${escape(inst.key)} → ${escape(inst.className)}@${escape(inst.handle)}</h3>
        ${!_activeAlive ? `<div style="color:var(--danger);font-size:11px;margin-bottom:8px">⚠ instance appears dead — re-capture to refresh</div>` : ""}
        <div class="ip-section-title">Fields (${_activeFields.length})</div>
        <div id="ip-fields"></div>
    `;
    const fc = v.querySelector<HTMLElement>("#ip-fields");
    if (!fc) return;
    for (const f of _activeFields) {
        // Field row component (Task 14 will replace this with the proper component).
        const div = document.createElement("div");
        div.className = "ip-field-row";
        div.innerHTML = `
            <span class="ip-field-name">${escape(f.name)}</span>
            <span class="ip-field-type">${escape(f.kind)}</span>
            <span class="ip-field-value">${escape(f.preview)}</span>
        `;
        fc.appendChild(div);
    }
}

function renderHistory(): void {
    if (!_hostEl) return;
    const h = _hostEl.querySelector<HTMLElement>("#ip-history");
    if (!h) return;
    h.innerHTML = `<div class="ip-section-title">History (${_history.length})${_history.length > 0 ? ` <button class="ip-pill" id="ip-clear-history" style="margin-left:8px">Clear</button>` : ""}</div>`;
    for (const e of _history) {
        const time = new Date(e.timestamp).toISOString().slice(11, 19);
        const div = document.createElement("div");
        div.className = "ip-history-row";
        const tag = `<span class="ip-history-tag ${e.action}">${e.action.toUpperCase()}</span>`;
        const body = e.action === "write"
            ? `${tag}${escape(e.target.instanceKey)}.${escape(e.target.member)}<br><span style="color:var(--text-faint)">${escape(e.before ?? "")} → ${escape(e.after ?? "")}</span>`
            : `${tag}${escape(e.target.instanceKey)}.${escape(e.target.member)}()<br><span style="color:var(--text-faint)">→ ${escape(e.callResult ?? "")}</span>`;
        div.innerHTML = `<div style="color:var(--text-faint);font-size:9px">${time}</div>${body}`;
        h.appendChild(div);
    }
    h.querySelector<HTMLButtonElement>("#ip-clear-history")?.addEventListener("click", async () => {
        await api.clearInstanceHistory();
    });
}

function bindToolbar(): void {
    if (!_hostEl) return;
    _hostEl.querySelector<HTMLButtonElement>("#ip-toggle-ro")?.addEventListener("click", async () => {
        await api.setInstancesReadOnly(!_readOnly);
    });
    _hostEl.querySelector<HTMLButtonElement>("#ip-refresh")?.addEventListener("click", () => { void loadAll(); });
    _hostEl.querySelector<HTMLButtonElement>("#ip-new-capture")?.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("instances:open-wizard"));
    });
    _hostEl.querySelector<HTMLButtonElement>("#ip-recipes")?.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("instances:open-recipes"));
    });
}
```

- [ ] **Step 3: Wire route in main router**

In the file from Step 1 (likely `app/frontend/main.ts`), add :

```typescript
import { mountInstancesPage } from "./pages/instances.js";
```

And add a hash route case:

```typescript
case "/instances":
    mountInstancesPage(content);
    break;
```

Match the existing pattern (e.g., maybe it's a switch on `location.hash.replace("#", "").split("?")[0]`).

- [ ] **Step 4: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add app/frontend/pages/instances.ts app/frontend/main.ts 2>/dev/null
git commit -m "feat(instances): page skeleton — sidebar + viewer + history zones"
```

---

## Task 14: Frontend — field row component with inline write

**Files:**
- Create: `app/frontend/components/instance-field-row.ts`
- Modify: `app/frontend/pages/instances.ts` (replace placeholder field rendering)

- [ ] **Step 1: Create the component**

Create `app/frontend/components/instance-field-row.ts`:

```typescript
import { api } from "../core/api.js";
import { icons } from "../core/icons.js";
import type { FieldReadLite } from "../core/types.js";

export interface FieldRowOptions {
    instanceKey: string;
    field: FieldReadLite;
    readOnly: boolean;
    onDrillDown(field: FieldReadLite): void;       // for nested / array
    onWriteSucceeded(): void;                      // re-load fields
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderFieldRow(opts: FieldRowOptions): HTMLElement {
    const { field: f, instanceKey, readOnly } = opts;
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.alignItems = "baseline";
    div.style.gap = "8px";
    div.style.padding = "3px 0";
    div.style.fontFamily = "var(--font-code)";
    div.style.fontSize = "12px";

    const name = `<span style="min-width:140px;color:var(--text-strong)">${escape(f.name)}</span>`;
    const type = `<span style="min-width:60px;color:var(--syntax-type);font-size:10px">${escape(f.kind)}</span>`;

    const editable = !readOnly && f.isWritable && (f.kind === "scalar" || f.kind === "string" || f.kind === "enum");
    const drillable = (f.kind === "nested" && f.nestedClass) || (f.kind === "array" && (f.arrayLength ?? 0) > 0);

    let valueHtml = `<span style="flex:1;color:var(--syntax-name)">${escape(f.preview)}</span>`;
    if (editable) {
        const initial = f.rawValue !== undefined ? String(f.rawValue) : "";
        valueHtml = `
            <input class="ip-input" data-edit="${escape(f.name)}" value="${escape(initial)}" style="flex:1">
            <button class="ip-pill" data-save="${escape(f.name)}">Save</button>
        `;
    } else if (drillable) {
        const target = f.kind === "nested" ? `→ ${escape(f.nestedClass!)}` : `[${f.arrayLength} items]`;
        valueHtml = `
            <span style="flex:1;color:var(--syntax-name)">${target}</span>
            <button class="ip-pill" data-drill="${escape(f.name)}">${icons.chevronRight(10)} Drill</button>
        `;
    }

    div.innerHTML = name + type + valueHtml;

    const saveBtn = div.querySelector<HTMLButtonElement>(`[data-save]`);
    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            const input = div.querySelector<HTMLInputElement>(`[data-edit]`);
            if (!input) return;
            const raw = input.value;
            // Coerce to the original type when possible
            let value: unknown = raw;
            if (typeof f.rawValue === "number") value = Number(raw);
            else if (typeof f.rawValue === "boolean") value = raw === "true" || raw === "1";
            try {
                await api.writeInstanceField(instanceKey, f.name, value);
                div.style.background = "rgba(34,197,94,0.15)";
                setTimeout(() => { div.style.background = ""; }, 800);
                opts.onWriteSucceeded();
            } catch (err) {
                alert(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    }

    const drillBtn = div.querySelector<HTMLButtonElement>(`[data-drill]`);
    if (drillBtn) drillBtn.addEventListener("click", () => opts.onDrillDown(f));

    return div;
}
```

- [ ] **Step 2: Use it in `pages/instances.ts`**

In `app/frontend/pages/instances.ts`, add at the top:

```typescript
import { renderFieldRow } from "../components/instance-field-row.js";
```

In the `renderViewer` function, replace the inline field-rendering loop with:

```typescript
for (const f of _activeFields) {
    fc.appendChild(renderFieldRow({
        instanceKey: _activeKey,
        field: f,
        readOnly: _readOnly,
        onDrillDown: (field) => {
            const asKey = `${_activeKey}.${field.name}`;
            if (field.kind === "nested") {
                void api.captureInstance({ op: "captureFieldValue", ownerKey: _activeKey!, fieldName: field.name, asKey });
            } else if (field.kind === "array") {
                const idx = window.prompt(`Array element index (0-${(field.arrayLength ?? 1) - 1}):`, "0");
                if (idx === null) return;
                void api.captureInstance({ op: "captureListElement", ownerKey: _activeKey!, listFieldName: field.name, index: parseInt(idx, 10), asKey: `${asKey}[${idx}]` });
            }
        },
        onWriteSucceeded: () => { void loadActiveFields().then(render); },
    }));
}
```

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/instance-field-row.ts app/frontend/pages/instances.ts
git commit -m "feat(instances): field-row component — inline writes + drill-down"
```

---

## Task 15: Frontend — capture wizard modal

**Files:**
- Create: `app/frontend/components/instance-capture-wizard-modal.ts`
- Modify: `app/frontend/pages/instances.ts` (mount the modal listener)

- [ ] **Step 1: Create the modal**

Create `app/frontend/components/instance-capture-wizard-modal.ts`:

```typescript
import { api } from "../core/api.js";
import type { InstanceRecipeStep, CapturedInstanceLite } from "../core/types.js";

interface WizardOptions {
    prefillClassName?: string;
    instances: CapturedInstanceLite[];
    onSubmitted(): void;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function openCaptureWizard(opts: WizardOptions): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:480px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">New capture</h3>
            <div style="display:flex;gap:4px;margin-bottom:12px">
                <button class="ip-pill" data-tab="gc">via GC</button>
                <button class="ip-pill" data-tab="hook">via Hook</button>
                <button class="ip-pill" data-tab="chain">chain</button>
            </div>
            <div id="wiz-form"></div>
            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-cancel>Cancel</button>
                <button class="ip-pill" data-submit style="background:var(--accent);color:var(--bg)">Capture</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let activeTab: "gc" | "hook" | "chain" = "gc";

    function renderForm(): void {
        const f = overlay.querySelector<HTMLElement>("#wiz-form");
        if (!f) return;
        if (activeTab === "gc") {
            f.innerHTML = `
                <label>className<input class="ip-input" id="wiz-cn" value="${escape(opts.prefillClassName ?? "")}" style="width:100%"></label><br><br>
                <label>index<input class="ip-input" id="wiz-idx" value="0" style="width:100%"></label><br><br>
                <label>asKey (registry name)<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
            // Auto-fill asKey from className
            const cnInput = overlay.querySelector<HTMLInputElement>("#wiz-cn");
            const keyInput = overlay.querySelector<HTMLInputElement>("#wiz-key");
            const sync = () => { if (keyInput && cnInput && !keyInput.dataset.touched) keyInput.value = cnInput.value.toLowerCase(); };
            cnInput?.addEventListener("input", sync); sync();
            keyInput?.addEventListener("input", () => { if (keyInput) keyInput.dataset.touched = "1"; });
        } else if (activeTab === "hook") {
            f.innerHTML = `
                <label>className<input class="ip-input" id="wiz-cn" value="${escape(opts.prefillClassName ?? "")}" style="width:100%"></label><br><br>
                <label>tickMethod (e.g., Update)<input class="ip-input" id="wiz-tm" value="Update" style="width:100%"></label><br><br>
                <label>timeoutMs<input class="ip-input" id="wiz-ms" value="10000" style="width:100%"></label><br><br>
                <label>asKey<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
        } else {
            const ownerOpts = opts.instances.map((i) => `<option value="${escape(i.key)}">${escape(i.key)} (${escape(i.className)})</option>`).join("");
            f.innerHTML = `
                <label>ownerKey<select class="ip-input" id="wiz-owner" style="width:100%">${ownerOpts}</select></label><br><br>
                <label>chain type<select class="ip-input" id="wiz-chain-kind" style="width:100%">
                    <option value="field">field</option>
                    <option value="list">list element</option>
                    <option value="method">method return</option>
                </select></label><br><br>
                <div id="wiz-chain-extras"></div>
                <label>asKey<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
            const renderExtras = () => {
                const kind = (overlay.querySelector<HTMLSelectElement>("#wiz-chain-kind")?.value ?? "field");
                const x = overlay.querySelector<HTMLElement>("#wiz-chain-extras");
                if (!x) return;
                if (kind === "field") {
                    x.innerHTML = `<label>fieldName<input class="ip-input" id="wiz-fn" value="" style="width:100%"></label><br><br>`;
                } else if (kind === "list") {
                    x.innerHTML = `<label>listFieldName<input class="ip-input" id="wiz-fn" value="" style="width:100%"></label><br><br><label>index<input class="ip-input" id="wiz-idx" value="0" style="width:100%"></label><br><br>`;
                } else {
                    x.innerHTML = `<label>methodName<input class="ip-input" id="wiz-mn" value="" style="width:100%"></label><br><br><label>args (JSON array)<input class="ip-input" id="wiz-args" value="[]" style="width:100%"></label><br><br>`;
                }
            };
            overlay.querySelector<HTMLSelectElement>("#wiz-chain-kind")?.addEventListener("change", renderExtras);
            renderExtras();
        }
    }
    renderForm();

    overlay.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
        b.addEventListener("click", () => { activeTab = b.dataset.tab as any; renderForm(); });
    });

    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => overlay.remove());

    overlay.querySelector<HTMLButtonElement>("[data-submit]")?.addEventListener("click", async () => {
        let payload: InstanceRecipeStep | null = null;
        const v = (id: string) => overlay.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value ?? "";
        try {
            if (activeTab === "gc") {
                payload = { op: "captureViaGC", className: v("wiz-cn"), index: parseInt(v("wiz-idx"), 10), asKey: v("wiz-key") };
            } else if (activeTab === "hook") {
                payload = { op: "captureViaHook", className: v("wiz-cn"), tickMethod: v("wiz-tm"), timeoutMs: parseInt(v("wiz-ms"), 10), asKey: v("wiz-key") };
            } else {
                const kind = v("wiz-chain-kind");
                if (kind === "field") {
                    payload = { op: "captureFieldValue", ownerKey: v("wiz-owner"), fieldName: v("wiz-fn"), asKey: v("wiz-key") };
                } else if (kind === "list") {
                    payload = { op: "captureListElement", ownerKey: v("wiz-owner"), listFieldName: v("wiz-fn"), index: parseInt(v("wiz-idx"), 10), asKey: v("wiz-key") };
                } else {
                    payload = { op: "captureMethodReturn", ownerKey: v("wiz-owner"), methodName: v("wiz-mn"), args: JSON.parse(v("wiz-args") || "[]"), asKey: v("wiz-key") };
                }
            }
            await api.captureInstance(payload!);
            overlay.remove();
            opts.onSubmitted();
        } catch (err) {
            alert(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
```

- [ ] **Step 2: Wire the listener in `pages/instances.ts`**

In `app/frontend/pages/instances.ts`, add at the top:

```typescript
import { openCaptureWizard } from "../components/instance-capture-wizard-modal.js";
```

In `mountInstancesPage`, after the `setTimeout` deep-link block, add:

```typescript
window.addEventListener("instances:open-wizard", ((ev: CustomEvent) => {
    openCaptureWizard({
        prefillClassName: ev.detail?.className,
        instances: _instances,
        onSubmitted: () => { void loadInstances(); },
    });
}) as EventListener);
```

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/instance-capture-wizard-modal.ts app/frontend/pages/instances.ts
git commit -m "feat(instances): capture wizard modal — GC/Hook/chain tabs"
```

---

## Task 16: Frontend — recipes modal

**Files:**
- Create: `app/frontend/components/instance-recipes-modal.ts`
- Modify: `app/frontend/pages/instances.ts`

- [ ] **Step 1: Create the modal**

Create `app/frontend/components/instance-recipes-modal.ts`:

```typescript
import { api } from "../core/api.js";
import type { InstanceRecipe } from "../core/types.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function openRecipesModal(): Promise<void> {
    const { recipes } = await api.listRecipes();
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;

    const renderBody = (rs: InstanceRecipe[]): string => {
        if (rs.length === 0) return `<div style="color:var(--text-faint);padding:16px;text-align:center">No recipes saved yet.</div>`;
        return rs.map((r) => `
            <div style="border-bottom:1px solid var(--border-strong);padding:8px 0" data-recipe="${escape(r.id)}">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                    <strong>${escape(r.name)}</strong>
                    <span style="font-size:10px;color:var(--text-faint)">${r.steps.length} steps · ${r.lastReplayedAt ? `last: ${r.lastReplayStatus}` : "never replayed"}</span>
                </div>
                ${r.description ? `<div style="font-size:11px;color:var(--text-faint);margin:4px 0">${escape(r.description)}</div>` : ""}
                <div style="display:flex;gap:6px;margin-top:6px">
                    <button class="ip-pill" data-replay="${escape(r.id)}">Replay</button>
                    <button class="ip-pill danger" data-delete="${escape(r.id)}">Delete</button>
                </div>
            </div>
        `).join("");
    };

    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:520px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">Recipes</h3>
            <div id="rec-list">${renderBody(recipes)}</div>
            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-close>Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", () => overlay.remove());

    overlay.querySelectorAll<HTMLButtonElement>("[data-replay]").forEach((b) => {
        b.addEventListener("click", async () => {
            const id = b.dataset.replay!;
            const result = await api.replayRecipe(id);
            const failedSteps = result.steps.filter((s) => !s.ok);
            const msg = `Replay ${result.finalStatus.toUpperCase()}: ${result.steps.length - failedSteps.length}/${result.steps.length} steps OK${failedSteps.length > 0 ? "\n\nFailures:\n" + failedSteps.map((s) => `  step ${s.stepIndex} (${s.op}): ${s.error}`).join("\n") : ""}`;
            alert(msg);
            overlay.remove();
        });
    });

    overlay.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) => {
        b.addEventListener("click", async () => {
            const id = b.dataset.delete!;
            if (!confirm("Delete this recipe?")) return;
            await api.deleteRecipe(id);
            const refreshed = await api.listRecipes();
            const list = overlay.querySelector<HTMLElement>("#rec-list");
            if (list) list.innerHTML = renderBody(refreshed.recipes);
        });
    });
}
```

- [ ] **Step 2: Wire the listener**

In `app/frontend/pages/instances.ts`, add:

```typescript
import { openRecipesModal } from "../components/instance-recipes-modal.js";
```

And in `mountInstancesPage`:

```typescript
window.addEventListener("instances:open-recipes", () => { void openRecipesModal(); });
```

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/instance-recipes-modal.ts app/frontend/pages/instances.ts
git commit -m "feat(instances): recipes modal — list/replay/delete"
```

---

## Task 17: Frontend — method call modal

**Files:**
- Create: `app/frontend/components/instance-call-modal.ts`
- Modify: `app/frontend/pages/instances.ts` (add Methods section + call buttons)

- [ ] **Step 1: Create the call modal**

Create `app/frontend/components/instance-call-modal.ts`:

```typescript
import { api } from "../core/api.js";

export interface CallModalOptions {
    instanceKey: string;
    methodName: string;
    parameters: Array<{ name: string; typeName: string }>;
    onResult(result: string): void;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function openCallModal(opts: CallModalOptions): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;
    const paramsHtml = opts.parameters.length === 0
        ? `<div style="color:var(--text-faint);font-size:11px">no parameters</div>`
        : opts.parameters.map((p) => `
            <label style="display:block;margin-bottom:8px"><span style="display:inline-block;min-width:100px">${escape(p.name)}</span><span style="font-size:10px;color:var(--text-faint)"> (${escape(p.typeName)})</span><br><input class="ip-input" data-param="${escape(p.name)}" style="width:100%"></label>
        `).join("");
    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:480px">
            <h3 style="margin-top:0">Call ${escape(opts.instanceKey)}.${escape(opts.methodName)}()</h3>
            <div style="margin-bottom:14px">${paramsHtml}</div>
            <div style="background:rgba(245,158,11,0.10);border:1px solid var(--warning);padding:8px;border-radius:4px;font-size:11px;margin-bottom:14px">
                ⚠ Calling this method executes game code. Risk: client may crash, server may desync.
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
                <button class="ip-pill" data-cancel>Cancel</button>
                <button class="ip-pill" data-call style="background:var(--warning);color:var(--bg)">Call</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector<HTMLButtonElement>("[data-call]")?.addEventListener("click", async () => {
        const args = opts.parameters.map((p) => {
            const v = overlay.querySelector<HTMLInputElement>(`[data-param="${p.name}"]`)?.value ?? "";
            // Cheap coercion based on type name
            if (p.typeName.includes("Int") || p.typeName.includes("Single") || p.typeName.includes("Double")) return Number(v);
            if (p.typeName === "System.Boolean") return v === "true";
            return v;
        });
        try {
            const r = await api.callInstanceMethod(opts.instanceKey, opts.methodName, args);
            opts.onResult(r.result);
            overlay.remove();
        } catch (err) {
            alert(`Call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
```

- [ ] **Step 2: Add Methods section to viewer**

In `app/frontend/pages/instances.ts`, replace `renderViewer` (or extend it) to include a Methods section. After the `<div id="ip-fields"></div>` line, add to the `v.innerHTML` template:

```html
<div class="ip-section-title" style="margin-top:18px">Methods (call)</div>
<div id="ip-methods"></div>
```

After populating fields, populate methods. To get the method list, we need an agent RPC `listInstanceMethods(key)` — but to keep this task focused, we'll reuse the Process Explorer's existing class-method listing via `api.rpc`. Add this snippet at the end of `renderViewer`:

```typescript
const mc = v.querySelector<HTMLElement>("#ip-methods");
if (mc) {
    // Lazy fetch methods via the agent's classes index (reuse explorer's listClassMembers)
    void api.rpc<{ methods: Array<{ name: string; parameters: Array<{ name: string; typeName: string }>; isStatic: boolean }> }>(
        "listClassMembers", [inst.className],
    ).then((r) => {
        const methods = r.result.methods.filter((m) => !m.isStatic);
        for (const m of methods) {
            const row = document.createElement("div");
            row.className = "ip-field-row";
            const sig = `${m.name}(${m.parameters.map((p) => p.typeName).join(", ")})`;
            row.innerHTML = `
                <span class="ip-field-name">${escape(m.name)}</span>
                <span class="ip-field-type" style="min-width:0">${escape(sig)}</span>
                <button class="ip-pill" data-call="${escape(m.name)}" ${_readOnly ? "disabled" : ""}>Call</button>
            `;
            row.querySelector<HTMLButtonElement>(`[data-call]`)?.addEventListener("click", () => {
                import("../components/instance-call-modal.js").then(({ openCallModal }) => {
                    openCallModal({
                        instanceKey: _activeKey!,
                        methodName: m.name,
                        parameters: m.parameters,
                        onResult: (result) => { /* shown in history panel via WS */ console.log("call result:", result); },
                    });
                });
            });
            mc.appendChild(row);
        }
    }).catch(() => { mc.innerHTML = `<div style="color:var(--text-faint);font-size:11px">unable to list methods</div>`; });
}
```

NOTE: `listClassMembers` is already exported by the agent (used by network plugin v1.2.1). Verify with: `grep "listClassMembers" src/rpc-agent/explorer.ts src/rpc-agent/inspector.ts`. If the response shape differs, adapt accordingly — the field used here is `methods[].{name, parameters[], isStatic}`.

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/instance-call-modal.ts app/frontend/pages/instances.ts
git commit -m "feat(instances): method call modal + Methods section in viewer"
```

---

## Task 18: Frontend — Class Detail button + nav-icons

**Files:**
- Modify: `app/frontend/components/class-detail.ts` (add ⊙ Instances button)
- Modify: `app/frontend/components/nav-icons.ts` (add Instances entry)
- Modify: `app/frontend/core/icons.ts` (verify `crosshair` icon exists; if not, the alternative is to use `box`)

- [ ] **Step 1: Add ⊙ Instances button to Class Detail**

Run: `grep -n "Hook\|Trace\|⇄ Net\|⇄.Net" app/frontend/components/class-detail.ts | head -5`

Find where the existing toolbar buttons (Hook / Trace / ⇄ Net) are rendered. Add immediately after the `⇄ Net` button:

```typescript
const instancesBtn = document.createElement("button");
instancesBtn.className = "icon-btn-mini";
instancesBtn.innerHTML = `${icons.crosshair(12)} Instances`;
instancesBtn.title = "Capture & inspect live instances of this class";
instancesBtn.addEventListener("click", () => {
    location.hash = `#/instances?class=${encodeURIComponent(currentClassName)}`;
});
toolbar.appendChild(instancesBtn);
```

(Use the variable name actually used for the toolbar HTMLElement and the current class name in the existing code — adapt to match.)

- [ ] **Step 2: Add nav-icon entry**

Run: `grep -n "Migrations\|Bookmarks\|Hooks" app/frontend/components/nav-icons.ts | head -5`

Find where the existing nav entries are defined. Add the Instances entry, alphabetically or following the existing order:

```typescript
{ label: "Instances", route: "#/instances", icon: icons.crosshair(16) },
```

(Match the actual entry-object shape used by the nav.)

- [ ] **Step 3: Build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add app/frontend/components/class-detail.ts app/frontend/components/nav-icons.ts
git commit -m "feat(instances): nav-icon + Class Detail deep-link button"
```

---

## Task 19: Frontend tests — page render + interactions

**Files:**
- Test: `app/test/frontend/pages/instances.test.ts`

- [ ] **Step 1: Create tests**

Create `app/test/frontend/pages/instances.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountInstancesPage } from "../../../frontend/pages/instances";

vi.mock("../../../frontend/core/ws.js", () => ({ subscribe: () => () => {} }));

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

beforeEach(() => { fetchMock.mockReset(); });

function mockEndpoints(state: { instances?: any[]; readOnly?: boolean; history?: any[]; fields?: any[] }): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/instances/list" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ instances: state.instances ?? [] }) });
        }
        if (url === "/api/instances/read-only" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: state.readOnly ?? true }) });
        }
        if (url === "/api/instances/history" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: state.history ?? [] }) });
        }
        if (url.match(/\/read-fields$/) && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ alive: true, fields: state.fields ?? [] }) });
        }
        if (url === "/api/instances/read-only" && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: !(state.readOnly ?? true) }) });
        }
        if (url.match(/\/write-field$/) && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ before: "0", after: "9999" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
}

describe("instances page", () => {
    it("renders empty state with toolbar buttons", async () => {
        mockEndpoints({});
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("New capture");
        expect(host.textContent).toContain("Recipes");
        expect(host.textContent).toContain("Read-Only");
    });

    it("renders captured instances in sidebar", async () => {
        mockEndpoints({
            instances: [
                { key: "player", className: "Player", handle: "0x1", capturedAt: "2026-05-07", capturedVia: "captureViaGC", isAlive: true },
                { key: "inv",    className: "Inventory", handle: "0x2", capturedAt: "2026-05-07", capturedVia: "captureFieldValue", isAlive: true },
            ],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("player");
        expect(host.textContent).toContain("Player@0x1");
        expect(host.textContent).toContain("inv");
    });

    it("Read-Only ON disables write inputs", async () => {
        mockEndpoints({
            readOnly: true,
            instances: [{ key: "p", className: "P", handle: "0x1", capturedAt: "x", capturedVia: "captureViaGC", isAlive: true }],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        // No editable input rendered when readOnly is true
        expect(host.querySelector<HTMLInputElement>('[data-edit]')).toBeNull();
    });

    it("Read-Only OFF + Save sends POST /write-field", async () => {
        mockEndpoints({
            readOnly: false,
            instances: [{ key: "p", className: "P", handle: "0x1", capturedAt: "x", capturedVia: "captureViaGC", isAlive: true }],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        const input = host.querySelector<HTMLInputElement>('[data-edit="health"]')!;
        input.value = "9999";
        const btn = host.querySelector<HTMLButtonElement>('[data-save="health"]')!;
        btn.click();
        await new Promise((r) => setTimeout(r, 10));
        const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/write-field"));
        expect(writeCall).toBeDefined();
        const body = JSON.parse((writeCall![1] as RequestInit).body as string);
        expect(body.fieldName).toBe("health");
        expect(body.value).toBe(9999);
    });

    it("Toggle Read-Only sends POST /read-only", async () => {
        mockEndpoints({ readOnly: true });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        const btn = host.querySelector<HTMLButtonElement>("#ip-toggle-ro")!;
        btn.click();
        await new Promise((r) => setTimeout(r, 10));
        const toggleCall = fetchMock.mock.calls.find((c) => c[0] === "/api/instances/read-only" && (c[1] as RequestInit)?.method === "POST");
        expect(toggleCall).toBeDefined();
    });

    it("renders history panel with WRITE/CALL tags", async () => {
        mockEndpoints({
            history: [
                { id: "1", timestamp: "2026-05-07T14:23:11Z", action: "write", target: { instanceKey: "p", member: "health" }, before: "100", after: "9999", success: true },
                { id: "2", timestamp: "2026-05-07T14:23:05Z", action: "call",  target: { instanceKey: "p", member: "Heal" }, callResult: "void", success: true },
            ],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("WRITE");
        expect(host.textContent).toContain("CALL");
        expect(host.textContent).toContain("100");
        expect(host.textContent).toContain("9999");
    });
});
```

- [ ] **Step 2: Run tests**

Run: `cd app && npx vitest run test/frontend/pages/instances.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 3: Run full suite**

Run: `cd app && npx vitest run`
Expected: PASS — total ~232 tests.

- [ ] **Step 4: Commit**

```bash
git add app/test/frontend/pages/instances.test.ts
git commit -m "test(instances): frontend page — render + interactions + Read-Only flow"
```

---

## Task 20: Final verification + smoke test

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Run: `cd app && npx tsc -p tsconfig.frontend.json --noEmit`
Expected: BOTH PASS

- [ ] **Step 2: Vite build**

Run: `cd app && npx vite build`
Expected: PASS

- [ ] **Step 3: All tests**

Run: `cd app && npx vitest run`
Expected: ~232 tests, all PASS. Report exact count.

- [ ] **Step 4: Agent build**

Run: `npm run build:rpc`
Expected: PASS

- [ ] **Step 5: Git state**

Run: `git log --oneline 13001ac..HEAD | wc -l` (count of commits since v1.4 spec)
Run: `git log --oneline 13001ac..HEAD` (full list)

Expected: ~20 commits.

Run: `git status`
Expected: clean except pre-existing untracked files.

- [ ] **Step 6: Integration sanity check (no attach)**

- `app/backend/core/instances/` contains 5 files (types, instance-registry, history-store, recipe-store, replay): `ls app/backend/core/instances`
- `app/backend/routes/instances.ts` exposes 14 endpoints: `grep -c "app\\." app/backend/routes/instances.ts`
- `app/backend/session.ts` has `instanceRegistry()`, `historyStore()`, `recipeStore()`, `getReadOnly()`, `setReadOnly()`, `agentCall()` accessors
- `app/frontend/pages/instances.ts` exports `mountInstancesPage`
- `app/frontend/components/instance-*.ts` exists (4 files)

Report each as ✓ or ✗.

- [ ] **Step 7: Smoke-test on Dofus (manual)**

Run: `npm --prefix app run dev` (from repo root) or `npm run dev` (from inside `app/`).

In the toolkit:
1. Attach to Dofus.
2. Navigate to Process Explorer, find a generic class with live instances (e.g., `PlayerCharacter`, or any class your version uses for the local player).
3. Click `⊙ Instances` button → page Instances opens with wizard pre-filled.
4. Submit GC capture → instance appears in sidebar, fields visible in central viewer.
5. Drill-down into a nested field → new entry in sidebar.
6. Toggle Read-Only OFF, modify a scalar field (e.g., a stat) → verify in-game effect.
7. Save current captures as a recipe ("PlayerSession") → restart game → replay one-click → all captures restored.
8. Test a method call on a known-safe getter method → check History panel.
9. Verify Read-Only ON blocks writes (input fields disabled).

NO commit required for verification.

If smoke test passes, v1.4 is complete on `toolkit-core-v1`. Use `superpowers:finishing-a-development-branch` to finalize.
