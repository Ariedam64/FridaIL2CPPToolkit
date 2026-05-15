# Dofus Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the Dofus character from its current map to a user-supplied destination mapId by composing the existing world-path A*, movement, and change-map facades through a single TravelOrchestrator with its own state, cancellation, and HTTP/UI surface.

**Architecture:** A single `TravelOrchestrator` class lives in `app/plugins/dofus/lib/movement/autopilot.ts`. It is constructed per session at `profile-attached` and disposed at `profile-detached`. It depends on a narrowed `TravelDeps` interface (6 getters/subscribers + 2 action objects + 1 path-compute function) so it can be unit-tested with simple stubs, without instantiating real stores. The loop is a sequential `for` over the world-path edges: `movement.moveTo` → wait for arrival on the transition cell (via PlayerStore.onChange + 15s timeout) → `changeMap.changeMap` → wait for the new mapId (via MapStateStore.onChange + 5s timeout). v1 only handles walk-off-edge transitions (filtered by `direction !== null`). Cancellation = boolean flag + per-await cancel callbacks. Status surface: `idle | running | done | failed | cancelled` plus `destMapId, currentEdgeIdx, totalEdges, currentTransitionCell, lastError, startedAt, finishedAt`. HTTP surface: 3 endpoints (POST start, POST cancel, GET status). UI surface: small panel in the State page header, polling `/status` every 500ms while running.

**Tech Stack:** TypeScript, Node.js (backend), Vitest (tests), Express (routes), no new runtime deps. Uses existing `MovementActions`, `ChangeMapActions`, `PlayerStore`, `MapStateStore`, and `world-path-js`.

---

## Task 1: `computeWorldPath` helper in `world-path.ts`

The autopilot needs a single function that takes `(srcMapId, destMapId)` and returns either edges or a clear failure reason. The same logic currently lives inline inside the `/api/dofus/world-pathfinding/compute` route. Extract it.

**Files:**
- Modify: `app/plugins/dofus/lib/movement/world-path.ts` (append helper)
- Test: `app/test/plugins/dofus/lib/world-path.test.ts` (NEW)

- [ ] **Step 1: Create test file with the failing test**

Create `app/test/plugins/dofus/lib/world-path.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { computeWorldPath, type ExtractedWorldGraph } from "../../../../plugins/dofus/lib/movement/world-path";

// Tiny in-memory graph: maps 1 → 2 → 3, single walkable transition each.
const MINI_GRAPH: ExtractedWorldGraph = {
    vertices: {
        "v1": { mapId: "1", zoneId: 1, uid: "v1" },
        "v2": { mapId: "2", zoneId: 1, uid: "v2" },
        "v3": { mapId: "3", zoneId: 1, uid: "v3" },
    },
    outgoing: {
        "v1": [{ fromUid: "v1", toUid: "v2", transitions: [{ cellId: 100, direction: 1, skillId: 0, transitionMapId: "2", type: 0, criterion: null, id: "t1" }] }],
        "v2": [{ fromUid: "v2", toUid: "v3", transitions: [{ cellId: 200, direction: 2, skillId: 0, transitionMapId: "3", type: 0, criterion: null, id: "t2" }] }],
        "v3": [],
    },
    verticesByMap: {
        "1": { "1": "v1" },
        "2": { "1": "v2" },
        "3": { "1": "v3" },
    },
};

describe("computeWorldPath", () => {
    it("returns ok with empty edges when src === dest", () => {
        const r = computeWorldPath(1, 1, MINI_GRAPH);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.edges).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/plugins/dofus/lib/world-path.test.ts`
Expected: FAIL — `computeWorldPath is not a function` (it's not exported yet)

- [ ] **Step 3: Add the helper to `world-path.ts`**

Open `app/plugins/dofus/lib/movement/world-path.ts`. After `pathToEdges`, append:

```ts
export type ComputeWorldPathResult =
    | { ok: true; edges: PathEdgeOut[]; iterations: number; elapsedMs: number }
    | { ok: false; reason: string };

/** Compute the world path from `srcMapId` to `destMapId`. Optionally accepts
 *  an explicit graph for tests; in production it reads the disk-cached graph
 *  via `loadGraph()`. Returns ok with an empty edge list when src===dest.
 *  Failure reasons: "graph not loaded", "srcMapId N not in graph",
 *  "destMapId N not in graph", "no path to N". */
export function computeWorldPath(
    srcMapId: number,
    destMapId: number,
    explicitGraph?: ExtractedWorldGraph,
): ComputeWorldPathResult {
    const graph = explicitGraph ?? loadGraph();
    if (!graph) return { ok: false, reason: "graph not loaded" };

    const srcV  = pickVertexForMap(graph, String(srcMapId));
    const destV = pickVertexForMap(graph, String(destMapId));
    if (!srcV)  return { ok: false, reason: `srcMapId ${srcMapId} not in graph` };
    if (!destV) return { ok: false, reason: `destMapId ${destMapId} not in graph` };

    if (srcV.uid === destV.uid) return { ok: true, edges: [], iterations: 0, elapsedMs: 0 };

    const t0 = Date.now();
    const search = aStar(graph, srcV.uid, destV.uid);
    const elapsedMs = Date.now() - t0;
    if (!search || search.pathUids.length === 0) {
        return { ok: false, reason: search?.exhausted ? `A* exhausted iteration cap` : `no path to ${destMapId}` };
    }
    return { ok: true, edges: pathToEdges(graph, search.pathUids), iterations: search.iterations, elapsedMs };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/plugins/dofus/lib/world-path.test.ts`
Expected: PASS

- [ ] **Step 5: Add the rest of the tests**

Append inside the same `describe` block:

```ts
    it("returns ok with edges for a valid 1→2→3 path", () => {
        const r = computeWorldPath(1, 3, MINI_GRAPH);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.edges.length).toBe(2);
            expect(r.edges[0].from.mapId).toBe("1");
            expect(r.edges[0].to.mapId).toBe("2");
            expect(r.edges[1].to.mapId).toBe("3");
        }
    });

    it("rejects when destMapId is not in graph", () => {
        const r = computeWorldPath(1, 999, MINI_GRAPH);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("destMapId 999 not in graph");
    });

    it("rejects when srcMapId is not in graph", () => {
        const r = computeWorldPath(999, 1, MINI_GRAPH);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("srcMapId 999 not in graph");
    });

    it("rejects when no path exists", () => {
        // Graph where 2 has no outgoing — 1 can reach 2 but not 3.
        const stuck: ExtractedWorldGraph = {
            ...MINI_GRAPH,
            outgoing: { ...MINI_GRAPH.outgoing, "v2": [] },
        };
        const r = computeWorldPath(1, 3, stuck);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("no path to 3");
    });
```

- [ ] **Step 6: Run all and verify**

Run: `cd app && npx vitest run test/plugins/dofus/lib/world-path.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 7: Commit**

```bash
git add app/plugins/dofus/lib/movement/world-path.ts app/test/plugins/dofus/lib/world-path.test.ts
git commit -m "feat(dofus): computeWorldPath helper factored from /compute route"
```

---

## Task 2: `TravelOrchestrator` skeleton + `getStatus()` + `dispose()`

A minimal class that holds state and exposes `getStatus`. No `start` logic yet — that comes in Tasks 4 and 5.

**Files:**
- Create: `app/plugins/dofus/lib/movement/autopilot.ts`
- Create: `app/test/plugins/dofus/lib/autopilot.test.ts`

- [ ] **Step 1: Write the test scaffolding + first failing test**

Create `app/test/plugins/dofus/lib/autopilot.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TravelOrchestrator, type TravelDeps } from "../../../../plugins/dofus/lib/movement/autopilot";
import type { PathEdgeOut } from "../../../../plugins/dofus/lib/movement/world-path";

class FakePlayer {
    cell: number | null = 100;
    moving = false;
    listeners: Array<() => void> = [];
    set(cell: number | null, moving: boolean): void {
        this.cell = cell; this.moving = moving;
        this.listeners.forEach(l => l());
    }
}

class FakeMap {
    mapId: number | null = 1;
    listeners: Array<() => void> = [];
    set(mapId: number | null): void {
        this.mapId = mapId;
        this.listeners.forEach(l => l());
    }
}

function makeDeps(opts: {
    player?: FakePlayer;
    map?: FakeMap;
    movement?: Partial<TravelDeps["movement"]>;
    changeMap?: Partial<TravelDeps["changeMap"]>;
    computeWorldPath?: TravelDeps["computeWorldPath"];
} = {}): TravelDeps {
    const player = opts.player ?? new FakePlayer();
    const map = opts.map ?? new FakeMap();
    return {
        getCurrentCell:  () => player.cell,
        isMoving:        () => player.moving,
        onPlayerChange:  (cb) => {
            player.listeners.push(cb);
            return () => { player.listeners = player.listeners.filter(l => l !== cb); };
        },
        getCurrentMapId: () => map.mapId,
        onMapChange:     (cb) => {
            map.listeners.push(cb);
            return () => { map.listeners = map.listeners.filter(l => l !== cb); };
        },
        movement:  { moveTo: vi.fn(async () => ({ ok: true, fromCell: 0, toCell: 0, mapId: 1 })), ...opts.movement } as any,
        changeMap: { changeMap: vi.fn(async () => ({ ok: true, mapId: 1, mode: "clean" as const })), ...opts.changeMap } as any,
        computeWorldPath: opts.computeWorldPath ?? (() => ({ ok: true, edges: [], iterations: 0, elapsedMs: 0 })),
    };
}

function walkableEdge(toMapId: string, cellId: number): PathEdgeOut {
    return {
        from: { mapId: "0", zoneId: 1, uid: "v0" },
        to:   { mapId: toMapId, zoneId: 1, uid: `v${toMapId}` },
        transitions: [{ cellId, direction: 1, skillId: 0, transitionMapId: toMapId, type: 0, criterion: null, id: "t" }],
    };
}

describe("TravelOrchestrator — skeleton", () => {
    it("starts in idle state with all status fields null", () => {
        const orch = new TravelOrchestrator(makeDeps());
        const s = orch.getStatus();
        expect(s.state).toBe("idle");
        expect(s.destMapId).toBeNull();
        expect(s.currentEdgeIdx).toBeNull();
        expect(s.totalEdges).toBeNull();
        expect(s.currentTransitionCell).toBeNull();
        expect(s.lastError).toBeNull();
        expect(s.startedAt).toBeNull();
        expect(s.finishedAt).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: FAIL — module `autopilot` not found

- [ ] **Step 3: Create the autopilot module**

Create `app/plugins/dofus/lib/movement/autopilot.ts`:

```ts
// Travel orchestrator: chains movement + change-map along the world-path
// graph to drive the character from its current map to a target mapId.
// v1 only handles walk-off-edge transitions (direction !== null). Single
// instance per session.

import type { MovementActions } from "./movement";
import type { ChangeMapActions } from "./change-map";
import type { ComputeWorldPathResult, PathEdgeOut } from "./world-path";

export type TravelState = "idle" | "running" | "done" | "failed" | "cancelled";

export interface TravelStatus {
    state: TravelState;
    destMapId: number | null;
    currentEdgeIdx: number | null;
    totalEdges: number | null;
    currentTransitionCell: number | null;
    lastError: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

export interface TravelDeps {
    getCurrentCell:   () => number | null;
    isMoving:         () => boolean;
    onPlayerChange:   (cb: () => void) => () => void;
    getCurrentMapId:  () => number | null;
    onMapChange:      (cb: () => void) => () => void;
    movement:         Pick<MovementActions, "moveTo">;
    changeMap:        Pick<ChangeMapActions, "changeMap">;
    computeWorldPath: (srcMapId: number, destMapId: number) => ComputeWorldPathResult;
}

export interface StartResult {
    ok: boolean;
    totalEdges?: number;
    alreadyOnMap?: boolean;
    reason?: string;
}

export class TravelOrchestrator {
    private status: TravelStatus = {
        state: "idle",
        destMapId: null,
        currentEdgeIdx: null,
        totalEdges: null,
        currentTransitionCell: null,
        lastError: null,
        startedAt: null,
        finishedAt: null,
    };

    constructor(private readonly deps: TravelDeps) {}

    getStatus(): TravelStatus {
        return { ...this.status };
    }

    dispose(): void {
        // Filled in Task 6.
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/movement/autopilot.ts app/test/plugins/dofus/lib/autopilot.test.ts
git commit -m "feat(dofus): TravelOrchestrator skeleton + getStatus"
```

---

## Task 3: `pickWalkable` helper

Pure function that picks the first walkable transition from an edge. Exported so it can be unit-tested directly.

**Files:**
- Modify: `app/plugins/dofus/lib/movement/autopilot.ts`
- Modify: `app/test/plugins/dofus/lib/autopilot.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `autopilot.test.ts`, after the import block, add `pickWalkable` to the imports:

```ts
import { TravelOrchestrator, pickWalkable, type TravelDeps } from "../../../../plugins/dofus/lib/movement/autopilot";
```

Append a new `describe` block at the bottom of the file:

```ts
describe("pickWalkable", () => {
    it("returns the first transition with direction !== null", () => {
        const t = pickWalkable([
            { cellId: 1, direction: null, skillId: 0, transitionMapId: "x", type: 5, criterion: null, id: "a" },
            { cellId: 2, direction: 3, skillId: 0, transitionMapId: "x", type: 0, criterion: null, id: "b" },
            { cellId: 3, direction: 5, skillId: 0, transitionMapId: "x", type: 0, criterion: null, id: "c" },
        ]);
        expect(t).not.toBeNull();
        expect(t!.cellId).toBe(2);
    });

    it("returns null when every transition has direction null (zaaps/portals only)", () => {
        const t = pickWalkable([
            { cellId: 1, direction: null, skillId: 0, transitionMapId: "x", type: 5, criterion: null, id: "a" },
            { cellId: 2, direction: null, skillId: 0, transitionMapId: "x", type: 5, criterion: null, id: "b" },
        ]);
        expect(t).toBeNull();
    });

    it("returns null for an empty transition list", () => {
        expect(pickWalkable([])).toBeNull();
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: FAIL — `pickWalkable` not exported

- [ ] **Step 3: Implement `pickWalkable`**

In `app/plugins/dofus/lib/movement/autopilot.ts`, add at the top after the imports:

```ts
import type { Transition } from "./world-path";
```

And after the `StartResult` interface, before the class:

```ts
/** Returns the first transition that triggers a natural map change by
 *  walking off a border cell (direction !== null). Returns null for edges
 *  that only contain zaaps / portals / scrollOfRecall (direction === null
 *  on those — v1 doesn't drive them). */
export function pickWalkable(transitions: readonly Transition[]): Transition | null {
    for (const t of transitions) {
        if (t.direction !== null) return t;
    }
    return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/movement/autopilot.ts app/test/plugins/dofus/lib/autopilot.test.ts
git commit -m "feat(dofus): pickWalkable helper"
```

---

## Task 4: `start()` — guards + planning failures

Implement guard clauses (already running, no current map/cell, ok-on-same-map shortcut) and planning-failure exits.

**Files:**
- Modify: `app/plugins/dofus/lib/movement/autopilot.ts`
- Modify: `app/test/plugins/dofus/lib/autopilot.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `autopilot.test.ts`:

```ts
describe("TravelOrchestrator.start — guards + planning", () => {
    it("returns done when already on destMapId (totalEdges=0, alreadyOnMap)", async () => {
        const map = new FakeMap(); map.set(42);
        const deps = makeDeps({ map, computeWorldPath: () => ({ ok: true, edges: [], iterations: 0, elapsedMs: 0 }) });
        const orch = new TravelOrchestrator(deps);
        const r = await orch.start(42);
        expect(r.ok).toBe(true);
        expect(r.alreadyOnMap).toBe(true);
        expect(r.totalEdges).toBe(0);
        expect(orch.getStatus().state).toBe("done");
    });

    it("rejects when not attached (no currentMapId)", async () => {
        const map = new FakeMap(); map.set(null);
        const deps = makeDeps({ map });
        const orch = new TravelOrchestrator(deps);
        const r = await orch.start(42);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("no current mapId");
        expect(orch.getStatus().state).toBe("idle"); // pre-validation: never moves out of idle
    });

    it("rejects when no currentCell", async () => {
        const player = new FakePlayer(); player.set(null, false);
        const deps = makeDeps({ player });
        const orch = new TravelOrchestrator(deps);
        const r = await orch.start(42);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("no current cell");
        expect(orch.getStatus().state).toBe("idle");
    });

    it("transitions to failed when computeWorldPath returns ok:false (no path)", async () => {
        const map = new FakeMap(); map.set(1);
        const deps = makeDeps({ map, computeWorldPath: () => ({ ok: false, reason: "no path to 42" }) });
        const orch = new TravelOrchestrator(deps);
        const r = await orch.start(42);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("no path to 42");
        const s = orch.getStatus();
        expect(s.state).toBe("failed");
        expect(s.lastError).toContain("no path to 42");
        expect(s.destMapId).toBe(42);
        expect(s.startedAt).not.toBeNull();
        expect(s.finishedAt).not.toBeNull();
    });

    it("rejects a second start while one is running", async () => {
        // Force the orchestrator to hang in waitForArrival by never firing onPlayerChange.
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const deps = makeDeps({
            map, movement: movement as any,
            computeWorldPath: () => ({ ok: true, edges: [walkableEdge("2", 200)], iterations: 0, elapsedMs: 0 }),
        });
        const orch = new TravelOrchestrator(deps);
        const first = orch.start(2);
        // Yield so the orchestrator reaches `running` state.
        await new Promise<void>(r => setImmediate(r));
        expect(orch.getStatus().state).toBe("running");
        const second = await orch.start(3);
        expect(second.ok).toBe(false);
        expect(second.reason).toContain("already running");
        // Cancel to allow `first` to settle without timing out the test runner.
        orch.cancel();
        await first;
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: FAIL — `start` not a function, or returns undefined

- [ ] **Step 3: Implement `start()` with guards + planning, and the `cancel` stub**

In `autopilot.ts`, inside the `TravelOrchestrator` class, add (replacing the empty `dispose`):

```ts
    private cancelled = false;
    private cancellers: Array<() => void> = [];

    async start(destMapId: number): Promise<StartResult> {
        // Pre-validation: never mutates status on failure.
        if (this.status.state === "running") {
            return { ok: false, reason: "travel already running" };
        }
        const currentMapId = this.deps.getCurrentMapId();
        if (currentMapId == null) {
            return { ok: false, reason: "no current mapId (not attached or map not yet known)" };
        }
        const currentCell = this.deps.getCurrentCell();
        if (currentCell == null) {
            return { ok: false, reason: "no current cell (player not yet localized)" };
        }

        // Accepted — initialize status.
        this.status = {
            state: "running",
            destMapId,
            currentEdgeIdx: null,
            totalEdges: null,
            currentTransitionCell: null,
            lastError: null,
            startedAt: Date.now(),
            finishedAt: null,
        };
        this.cancelled = false;
        this.cancellers = [];

        const plan = this.deps.computeWorldPath(currentMapId, destMapId);
        if (!plan.ok) {
            return this.finish("failed", plan.reason);
        }
        this.status.totalEdges = plan.edges.length;

        if (plan.edges.length === 0) {
            // Already on destination map.
            this.finish("done");
            return { ok: true, totalEdges: 0, alreadyOnMap: true };
        }

        // Edge loop comes in Task 5. For now, just finish as if successful.
        // (This intermediate state is replaced in Task 5.)
        this.finish("done");
        return { ok: true, totalEdges: plan.edges.length };
    }

    cancel(): { ok: boolean; wasRunning: boolean } {
        const wasRunning = this.status.state === "running";
        this.cancelled = true;
        const fns = this.cancellers.slice();
        this.cancellers = [];
        for (const f of fns) { try { f(); } catch { /* noop */ } }
        return { ok: true, wasRunning };
    }

    private finish(state: TravelState, lastError?: string): StartResult {
        this.status.state = state;
        this.status.finishedAt = Date.now();
        if (lastError) this.status.lastError = lastError;
        return { ok: state === "done", reason: lastError, totalEdges: this.status.totalEdges ?? undefined };
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: PASS (all 9 tests so far)

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/movement/autopilot.ts app/test/plugins/dofus/lib/autopilot.test.ts
git commit -m "feat(dofus): TravelOrchestrator.start guards + planning"
```

---

## Task 5: `start()` — edge loop + `waitForArrival` + `waitForMap`

Wire the actual loop: pick walkable transition → `movement.moveTo` → wait for arrival → `changeMap.changeMap` → wait for map.

**Files:**
- Modify: `app/plugins/dofus/lib/movement/autopilot.ts`
- Modify: `app/test/plugins/dofus/lib/autopilot.test.ts`

- [ ] **Step 1: Add failing tests for the happy path**

Append to `autopilot.test.ts`:

```ts
describe("TravelOrchestrator.start — edge loop", () => {
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    it("walks + changes map across a 2-edge path", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const changeMap = { changeMap: vi.fn(async () => ({ ok: true, mapId: 2, mode: "clean" as const })) };
        const deps = makeDeps({
            player, map, movement: movement as any, changeMap: changeMap as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [
                walkableEdge("2", 200),
                walkableEdge("3", 300),
            ]}),
        });
        const orch = new TravelOrchestrator(deps);

        const startP = orch.start(3);

        // Edge 0: simulate arrival on map 1 at cell 200, then map switch to 2 with entry cell 50.
        await flush();
        player.set(200, false);  // arrived on transition cell
        await flush();
        map.set(2);
        player.set(50, false);   // entry cell on map 2
        await flush();

        // Edge 1: arrive on map 2 at cell 300, then map switch to 3 with entry cell 70.
        player.set(300, false);
        await flush();
        map.set(3);
        player.set(70, false);
        await flush();

        const r = await startP;
        expect(r.ok).toBe(true);
        expect(r.totalEdges).toBe(2);
        expect(movement.moveTo).toHaveBeenCalledTimes(2);
        expect(changeMap.changeMap).toHaveBeenCalledTimes(2);
        expect(orch.getStatus().state).toBe("done");
        expect(orch.getStatus().currentEdgeIdx).toBe(1);
    });

    it("fails when an edge has no walkable transition", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const zaapOnly: PathEdgeOut = {
            from: { mapId: "1", zoneId: 1, uid: "v1" },
            to:   { mapId: "2", zoneId: 1, uid: "v2" },
            transitions: [{ cellId: 1, direction: null, skillId: 99, transitionMapId: "2", type: 5, criterion: null, id: "z1" }],
        };
        const deps = makeDeps({
            player, map,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [zaapOnly] }),
        });
        const orch = new TravelOrchestrator(deps);

        const r = await orch.start(2);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("no walkable transition");
        expect(orch.getStatus().state).toBe("failed");
        expect(orch.getStatus().currentEdgeIdx).toBe(0);
    });

    it("fails when movement.moveTo returns ok:false", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: false, fromCell: 100, toCell: 200, reason: "agent send error" })) };
        const deps = makeDeps({
            player, map, movement: movement as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
        });
        const orch = new TravelOrchestrator(deps);

        const r = await orch.start(2);
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("agent send error");
        expect(orch.getStatus().state).toBe("failed");
    });

    it("fails when changeMap returns ok:false", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const changeMap = { changeMap: vi.fn(async () => ({ ok: false, mapId: 2, mode: "clean" as const, reason: "kta timeout" })) };
        const deps = makeDeps({
            player, map, movement: movement as any, changeMap: changeMap as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
        });
        const orch = new TravelOrchestrator(deps);

        const startP = orch.start(2);
        await flush();
        player.set(200, false);  // arrival
        await flush();

        const r = await startP;
        expect(r.ok).toBe(false);
        expect(r.reason).toContain("kta timeout");
        expect(orch.getStatus().state).toBe("failed");
    });

    it("fails on arrival timeout (15s)", async () => {
        vi.useFakeTimers();
        try {
            const player = new FakePlayer(); player.set(100, false);
            const map = new FakeMap(); map.set(1);
            const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
            const deps = makeDeps({
                player, map, movement: movement as any,
                computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
            });
            const orch = new TravelOrchestrator(deps);

            const startP = orch.start(2);
            await vi.advanceTimersByTimeAsync(20_000);
            const r = await startP;

            expect(r.ok).toBe(false);
            expect(r.reason).toContain("arrival timeout");
            expect(orch.getStatus().state).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: 5 new tests FAIL (orchestrator doesn't loop or wait yet)

- [ ] **Step 3: Replace the stubbed `start()` body with the real loop**

In `autopilot.ts`, replace the previous `start()` body. Keep the guards and planning; replace the placeholder "edge loop comes in Task 5" with the real loop. Also add the two private helpers `waitForArrival` and `waitForMap` and a `throwIfCancelled` helper.

Inside the `TravelOrchestrator` class, replace the previous `start()` and append the helpers:

```ts
    async start(destMapId: number): Promise<StartResult> {
        if (this.status.state === "running") {
            return { ok: false, reason: "travel already running" };
        }
        const currentMapId = this.deps.getCurrentMapId();
        if (currentMapId == null) {
            return { ok: false, reason: "no current mapId (not attached or map not yet known)" };
        }
        const currentCell = this.deps.getCurrentCell();
        if (currentCell == null) {
            return { ok: false, reason: "no current cell (player not yet localized)" };
        }

        this.status = {
            state: "running",
            destMapId,
            currentEdgeIdx: null,
            totalEdges: null,
            currentTransitionCell: null,
            lastError: null,
            startedAt: Date.now(),
            finishedAt: null,
        };
        this.cancelled = false;
        this.cancellers = [];

        const plan = this.deps.computeWorldPath(currentMapId, destMapId);
        if (!plan.ok) {
            return this.finish("failed", plan.reason);
        }
        this.status.totalEdges = plan.edges.length;

        if (plan.edges.length === 0) {
            this.finish("done");
            return { ok: true, totalEdges: 0, alreadyOnMap: true };
        }

        try {
            for (let i = 0; i < plan.edges.length; i++) {
                this.status.currentEdgeIdx = i;
                this.throwIfCancelled();

                const t = pickWalkable(plan.edges[i].transitions);
                if (!t) throw new Error(`edge ${i}: no walkable transition (zaaps/portals only)`);
                this.status.currentTransitionCell = t.cellId;

                const fromCell = this.deps.getCurrentCell();
                if (fromCell == null) throw new Error("current cell unknown mid-travel");
                const mapNow = this.deps.getCurrentMapId() ?? undefined;
                const move = await this.deps.movement.moveTo(fromCell, t.cellId, mapNow);
                if (!move.ok) throw new Error(`movement: ${move.reason ?? "send failed"}`);

                await this.waitForArrival(t.cellId);
                this.throwIfCancelled();

                const nextMapId = Number(plan.edges[i].to.mapId);
                const cm = await this.deps.changeMap.changeMap(nextMapId);
                if (!cm.ok) throw new Error(`changeMap: ${cm.reason ?? "send failed"}`);

                await this.waitForMap(nextMapId);
                this.status.currentTransitionCell = null;
            }
            return this.finish("done");
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            return this.finish(this.cancelled ? "cancelled" : "failed", reason);
        }
    }

    private throwIfCancelled(): void {
        if (this.cancelled) throw new Error("cancelled");
    }

    private waitForArrival(cellId: number, timeoutMs = 15_000): Promise<void> {
        return this.awaitCondition(
            () => this.deps.getCurrentCell() === cellId && !this.deps.isMoving(),
            this.deps.onPlayerChange,
            timeoutMs,
            `arrival timeout at cell ${cellId}`,
        );
    }

    private waitForMap(mapId: number, timeoutMs = 5_000): Promise<void> {
        return this.awaitCondition(
            () => this.deps.getCurrentMapId() === mapId,
            this.deps.onMapChange,
            timeoutMs,
            `map change timeout: expected ${mapId}, got ${this.deps.getCurrentMapId()}`,
        );
    }

    private awaitCondition(
        cond: () => boolean,
        subscribe: (cb: () => void) => () => void,
        timeoutMs: number,
        timeoutReason: string,
    ): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // Immediate check: maybe the condition is already true.
            if (cond()) return resolve();
            if (this.cancelled) return reject(new Error("cancelled"));

            let settled = false;
            const cleanup = (): void => {
                settled = true;
                unsub();
                clearTimeout(timer);
                const i = this.cancellers.indexOf(cancelFn);
                if (i >= 0) this.cancellers.splice(i, 1);
            };
            const unsub = subscribe(() => {
                if (settled) return;
                if (cond()) { cleanup(); resolve(); }
            });
            const timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error(timeoutReason));
            }, timeoutMs);
            const cancelFn = (): void => {
                if (settled) return;
                cleanup();
                reject(new Error("cancelled"));
            };
            this.cancellers.push(cancelFn);
        });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: PASS (all 14 tests so far)

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/movement/autopilot.ts app/test/plugins/dofus/lib/autopilot.test.ts
git commit -m "feat(dofus): TravelOrchestrator edge loop + waitForArrival/Map"
```

---

## Task 6: `cancel()` mid-travel + `dispose()`

The previous `cancel()` only sets the flag. The edge loop honors `throwIfCancelled` between awaits, but a cancel during a `waitForArrival` must reject the pending Promise — which the `cancellers` list already supports. Add a test for it, and implement `dispose()`.

**Files:**
- Modify: `app/plugins/dofus/lib/movement/autopilot.ts`
- Modify: `app/test/plugins/dofus/lib/autopilot.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `autopilot.test.ts`:

```ts
describe("TravelOrchestrator.cancel + dispose", () => {
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    it("cancels during waitForArrival → state=cancelled, changeMap not called", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const changeMap = { changeMap: vi.fn(async () => ({ ok: true, mapId: 2, mode: "clean" as const })) };
        const deps = makeDeps({
            player, map, movement: movement as any, changeMap: changeMap as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
        });
        const orch = new TravelOrchestrator(deps);

        const startP = orch.start(2);
        await flush();
        expect(orch.getStatus().state).toBe("running");
        expect(movement.moveTo).toHaveBeenCalledOnce();

        const c = orch.cancel();
        expect(c.wasRunning).toBe(true);
        await startP;

        expect(orch.getStatus().state).toBe("cancelled");
        expect(changeMap.changeMap).not.toHaveBeenCalled();
    });

    it("cancel on an idle orchestrator returns wasRunning=false", () => {
        const orch = new TravelOrchestrator(makeDeps());
        const c = orch.cancel();
        expect(c.wasRunning).toBe(false);
        expect(orch.getStatus().state).toBe("idle");
    });

    it("dispose cancels any in-flight travel and leaves status as cancelled", async () => {
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const deps = makeDeps({
            player, map, movement: movement as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
        });
        const orch = new TravelOrchestrator(deps);

        const startP = orch.start(2);
        await flush();
        orch.dispose();
        await startP;

        expect(orch.getStatus().state).toBe("cancelled");
    });
});
```

- [ ] **Step 2: Run tests to verify the dispose one fails**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: The dispose test FAILS (current `dispose` is empty). The cancel tests should already pass thanks to Task 5's plumbing.

- [ ] **Step 3: Implement `dispose()`**

In `autopilot.ts`, replace the empty `dispose` near the top of the class:

```ts
    dispose(): void {
        // Re-uses cancel() so any pending await rejects promptly. We don't
        // null out deps — the orchestrator becomes single-use after dispose
        // and the route layer drops its reference on profile-detached.
        this.cancel();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd app && npx vitest run test/plugins/dofus/lib/autopilot.test.ts`
Expected: PASS (all 17 tests)

- [ ] **Step 5: Commit**

```bash
git add app/plugins/dofus/lib/movement/autopilot.ts app/test/plugins/dofus/lib/autopilot.test.ts
git commit -m "feat(dofus): TravelOrchestrator cancel + dispose"
```

---

## Task 7: Wire orchestrator in `routes/index.ts` + refactor `/compute` to use helper

Create the orchestrator alongside `playerStore`/`mapStateStore`, dispose on detach, and replace the inline A* in the existing `/world-pathfinding/compute` route with a call to `computeWorldPath`.

**Files:**
- Modify: `app/plugins/dofus/routes/index.ts`

- [ ] **Step 1: Add the imports**

Open `app/plugins/dofus/routes/index.ts`. Find the import block at the top and add (after `import { resolveProto } from "../lib/protocol/resolver";`):

```ts
import { TravelOrchestrator } from "../lib/movement/autopilot";
import { MovementActions } from "../lib/movement/movement";
import { ChangeMapActions } from "../lib/movement/change-map";
import { computeWorldPath } from "../lib/movement/world-path";
```

(Note: `MovementActions` and `ChangeMapActions` are already used inline lower in the file. If they're already imported, leave them.)

- [ ] **Step 2: Add the orchestrator field + wire it in `rewireStores`**

Locate the existing `let playerStore: PlayerStore | null = null;` block (around line 87). After the existing `let mapStateStore: MapStateStore | null = null;`, add:

```ts
    let autopilot: TravelOrchestrator | null = null;
```

In `rewireStores()`, after the block that creates `playerStore` and `mapStateStore`, before `void playerStore.refresh();`, add:

```ts
        const movementForAutopilot = new MovementActions(profile.labels, deps.session.fridaClient, mapInteractives, store);
        const changeMapForAutopilot = new ChangeMapActions(
            profile.labels,
            deps.session.fridaClient,
            () => deps.session.frameStore(),
        );
        autopilot = new TravelOrchestrator({
            getCurrentCell:   () => playerStore!.getState().currentCellId,
            isMoving:         () => playerStore!.getState().isMoving,
            onPlayerChange:   (cb) => playerStore!.onChange(() => cb()),
            getCurrentMapId:  () => mapStateStore!.getState().mapId,
            onMapChange:      (cb) => mapStateStore!.onChange(() => cb()),
            movement:         movementForAutopilot,
            changeMap:        changeMapForAutopilot,
            computeWorldPath: (src, dest) => computeWorldPath(src, dest),
        });
```

In the `rewireStores()` cleanup at the top of the same function, add to the existing if-blocks:

```ts
        if (autopilot) { autopilot.dispose(); autopilot = null; }
```

In the `profile-detached` handler block (around line 130), add the same cleanup before `rewireInteractives();`:

```ts
        if (autopilot) { autopilot.dispose(); autopilot = null; }
```

- [ ] **Step 3: Refactor `/world-pathfinding/compute` to use the helper**

Locate the existing handler:
```ts
app.post("/api/dofus/world-pathfinding/compute", async (req, res) => {
```

Inside it, find the block that does `const { loadGraph, pickVertexForMap, aStar, pathToEdges } = await import("../lib/movement/world-path.js");` (and the dynamic graph extraction). Replace the entire `try { ... }` body that runs after request validation with this version, which keeps the auto-extract logic but routes the path compute through `computeWorldPath`:

```ts
        try {
            // First call after attach: auto-extract the graph from the live
            // PathFindingData. Subsequent calls are pure JS over the cache.
            const { loadGraph, saveGraph } = await import("../lib/movement/world-path.js");
            let graph = loadGraph();
            if (!graph) {
                const result = await deps.session.fridaClient.call("extractWorldGraph", [{
                    proto: worldPathfindingProto(profile),
                }]) as any;
                if (!result?.ok) { res.status(500).json({ error: `graph extraction failed: ${result?.reason ?? "unknown"}` }); return; }
                saveGraph({
                    vertices: result.vertices,
                    outgoing: result.outgoing,
                    verticesByMap: result.verticesByMap,
                    counts: result.counts,
                });
                graph = loadGraph();
            }
            if (!graph) { res.status(500).json({ error: "graph load failed after extract" }); return; }

            const out = computeWorldPath(Number(srcMapId), Number(destMapId), graph);
            if (!out.ok) {
                res.json({ ok: false, reason: out.reason });
                return;
            }
            res.json({
                ok: true,
                fresh: true,
                edges: out.edges.map((e) => ({ from: e.from, to: e.to, transitions: e.transitions })),
                iterations: out.iterations,
                elapsedMs: out.elapsedMs,
            });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
```

- [ ] **Step 4: Run tsc to verify the refactor compiles**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Expected: exit 0

- [ ] **Step 5: Re-run the full test suite to confirm no regression**

Run: `cd app && npx vitest run`
Expected: existing tests remain passing (autopilot tests pass too); the 25 pre-existing unrelated failures remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add app/plugins/dofus/routes/index.ts
git commit -m "feat(dofus): wire TravelOrchestrator + refactor /compute through helper"
```

---

## Task 8: New HTTP endpoints (`/travel/start`, `/travel/cancel`, `/travel/status`)

**Files:**
- Modify: `app/plugins/dofus/routes/index.ts`

- [ ] **Step 1: Add the three handlers**

In `app/plugins/dofus/routes/index.ts`, add the three handlers below the existing `app.post("/api/dofus/map/change", ...)` handler (before `// ---- Interactive use (...)`):

```ts
    // ---- Autopilot (movement + change-map chain) ----
    //
    // Single instance per session (`autopilot` above). Endpoints are inert
    // when no profile is attached. `start` returns synchronously once
    // planning settles; the loop runs in the background. Caller polls
    // `/status` to observe progression.
    app.post("/api/dofus/travel/start", async (req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        const destMapId = Number(req.body?.destMapId);
        if (!Number.isFinite(destMapId)) {
            res.status(400).json({ error: "destMapId required" });
            return;
        }
        // Pre-check 'already running' so we can return a clean 409 (the
        // orchestrator's own guard returns 200 ok:false, which the UI would
        // misclassify as a planning failure).
        if (autopilot.getStatus().state === "running") {
            res.status(409).json({ error: "travel already running" });
            return;
        }
        // Fire-and-forget the orchestrator: the start() promise resolves
        // when the WHOLE travel ends, not when planning settles. The HTTP
        // response should only reflect planning outcome — kick start() in
        // the background, then peek getStatus() after one tick.
        const startP = autopilot.start(destMapId);
        // Yield once so synchronous-failure paths ("no path", "destMapId
        // not in graph", "already on destination") have flushed into status.
        await new Promise<void>(r => setImmediate(r));
        const s = autopilot.getStatus();
        if (s.state === "failed") {
            // Planning failure (also "no current cell/mapId" guards).
            // Surface synchronously, swallow startP (already settled).
            void startP;
            res.json({ ok: false, reason: s.lastError });
            return;
        }
        if (s.state === "done") {
            void startP;
            res.json({ ok: true, totalEdges: 0, alreadyOnMap: true });
            return;
        }
        // state === "running" — travel kicked off, loop runs in background.
        // Don't await startP (would block until the whole journey ends).
        void startP;
        res.json({ ok: true, totalEdges: s.totalEdges });
    });

    app.post("/api/dofus/travel/cancel", (_req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        res.json(autopilot.cancel());
    });

    app.get("/api/dofus/travel/status", (_req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        res.json(autopilot.getStatus());
    });
```

- [ ] **Step 2: Verify tsc**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add app/plugins/dofus/routes/index.ts
git commit -m "feat(dofus): HTTP endpoints /travel/start, /cancel, /status"
```

---

## Task 9: State page autopilot panel

A small panel inserted in the state page. Idle: input + Go. Running: progress text + Cancel. Done/Failed/Cancelled: status line + input + Go.

**Files:**
- Modify: `app/plugins/dofus/pages/state.ts`

- [ ] **Step 1: Add the panel mount + render function near the top of the file**

Open `app/plugins/dofus/pages/state.ts`. Inspect the existing module-scope state and render functions. After the existing `const mapState: MapState = ...` declaration (around line 109), add:

```ts
// =============================================================================
// Autopilot panel state
// =============================================================================

interface TravelStatus {
    state: "idle" | "running" | "done" | "failed" | "cancelled";
    destMapId: number | null;
    currentEdgeIdx: number | null;
    totalEdges: number | null;
    currentTransitionCell: number | null;
    lastError: string | null;
    startedAt: number | null;
    finishedAt: number | null;
}

const travelStatus: TravelStatus = {
    state: "idle",
    destMapId: null,
    currentEdgeIdx: null,
    totalEdges: null,
    currentTransitionCell: null,
    lastError: null,
    startedAt: null,
    finishedAt: null,
};

let travelPollTimer: ReturnType<typeof setInterval> | null = null;
const TRAVEL_POLL_MS = 500;

async function fetchTravelStatus(): Promise<void> {
    try {
        const r = await fetch("/api/dofus/travel/status");
        if (!r.ok) return;
        const s = await r.json() as TravelStatus;
        Object.assign(travelStatus, s);
    } catch { /* leave previous */ }
}

function startTravelPoll(host: HTMLElement): void {
    if (travelPollTimer) return;
    travelPollTimer = setInterval(async () => {
        await fetchTravelStatus();
        renderAutopilotPanel(host);
        if (travelStatus.state !== "running") {
            if (travelPollTimer) { clearInterval(travelPollTimer); travelPollTimer = null; }
        }
    }, TRAVEL_POLL_MS);
}

function stopTravelPoll(): void {
    if (travelPollTimer) { clearInterval(travelPollTimer); travelPollTimer = null; }
}
```

- [ ] **Step 2: Add the render function**

After the existing `function renderHeader(host: HTMLElement): void` (around line 186), add:

```ts
function renderAutopilotPanel(host: HTMLElement): void {
    const slot = host.querySelector<HTMLElement>("[data-region='autopilot']");
    if (!slot) return;

    const s = travelStatus;
    const showInput = s.state !== "running";

    let body = "";
    if (s.state === "running") {
        const step = (s.currentEdgeIdx ?? 0) + 1;
        body = `
            <div style="display:flex;align-items:center;gap:12px;color:#a78bfa">
                <span>→ Map ${s.destMapId}</span>
                <span style="color:#666">·</span>
                <span>step ${step}/${s.totalEdges ?? "?"}</span>
                ${s.currentTransitionCell != null ? `<span style="color:#666">·</span><span>cell ${s.currentTransitionCell}</span>` : ""}
                <button data-action="travel-cancel" style="margin-left:auto">Cancel</button>
            </div>`;
    } else if (s.state === "done") {
        const elapsed = s.startedAt && s.finishedAt ? Math.round((s.finishedAt - s.startedAt) / 1000) : null;
        body = `<div style="color:#86efac">✓ Arrivé à ${s.destMapId}${s.totalEdges != null ? `  (${s.totalEdges} steps${elapsed != null ? `, ${elapsed}s` : ""})` : ""}</div>`;
    } else if (s.state === "failed") {
        body = `<div style="color:#fca5a5">✗ failed: ${escapeHtml(s.lastError ?? "unknown")}</div>`;
    } else if (s.state === "cancelled") {
        body = `<div style="color:#fcd34d">⊘ cancelled</div>`;
    }

    const inputRow = showInput ? `
        <div style="display:flex;align-items:center;gap:8px;margin-top:${body ? "6px" : "0"}">
            <span style="color:#888;font-size:11px">Aller à map</span>
            <input data-input="travel-dest" type="number" placeholder="mapId" style="width:140px;background:#1a1a1a;border:1px solid #333;color:#ddd;padding:4px 6px;font:11px monospace" />
            <button data-action="travel-go">Go</button>
        </div>` : "";

    slot.innerHTML = `
        <div style="border:1px solid #2a2a2a;padding:8px 10px;border-radius:4px;background:#181818;margin-top:8px">
            <div style="color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Autopilot</div>
            ${body}
            ${inputRow}
        </div>`;
}
```

- [ ] **Step 3: Insert the panel slot in the header markup**

Find the existing `renderHeader` function. After it appends its content (the existing `slot.innerHTML = ...` block ending around line 220-230), look further down for where the page's main HTML scaffold is set. Inside that scaffold (typically a top-level `mount` function or similar that calls `host.innerHTML = ...` with `data-region` attributes), add a sibling div immediately after the existing `data-region='header'`:

```html
<div data-region="autopilot"></div>
```

If the scaffold uses a string template, append `<div data-region="autopilot"></div>` after the `<div data-region="header"></div>` line. If you can't easily locate it, search for `data-region="header"` in the file and add the new line right after it.

- [ ] **Step 4: Wire the button handlers + initial render**

Find the main page mount/init function (the entry point that returns the page or sets up event listeners). After the existing render calls (`renderHeader(host)` etc.), add:

```ts
    // Initial autopilot fetch + render.
    void fetchTravelStatus().then(() => renderAutopilotPanel(host));

    // Delegated click handler for autopilot buttons.
    host.addEventListener("click", async (ev) => {
        const t = ev.target as HTMLElement;
        const action = t.getAttribute?.("data-action");
        if (action === "travel-go") {
            const input = host.querySelector<HTMLInputElement>("[data-input='travel-dest']");
            const destMapId = Number(input?.value ?? "");
            if (!Number.isFinite(destMapId)) return;
            try {
                const r = await fetch("/api/dofus/travel/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ destMapId }),
                });
                const body = await r.json();
                if (r.ok && body?.ok) {
                    await fetchTravelStatus();
                    renderAutopilotPanel(host);
                    if (travelStatus.state === "running") startTravelPoll(host);
                } else {
                    travelStatus.state = "failed";
                    travelStatus.lastError = body?.reason ?? body?.error ?? `HTTP ${r.status}`;
                    renderAutopilotPanel(host);
                }
            } catch (e) {
                travelStatus.state = "failed";
                travelStatus.lastError = String((e as Error).message);
                renderAutopilotPanel(host);
            }
        } else if (action === "travel-cancel") {
            try { await fetch("/api/dofus/travel/cancel", { method: "POST" }); } catch {}
            await fetchTravelStatus();
            renderAutopilotPanel(host);
        }
    });
```

- [ ] **Step 5: Stop the poll on page unmount**

If the page exposes a cleanup callback (look for `return () => { ... }` at the end of the mount function), add `stopTravelPoll();` to it. If there is no cleanup return, leave the poll to die on its own when the page is replaced — `clearInterval` would still benefit; in that case add a beforeunload handler or simply leave it (the interval is cheap and the UI is single-page).

- [ ] **Step 6: Verify the frontend builds**

Run: `cd app && npx vite build`
Expected: builds cleanly, no errors.

- [ ] **Step 7: Commit**

```bash
git add app/plugins/dofus/pages/state.ts
git commit -m "feat(dofus): autopilot panel on state page"
```

---

## Task 10: Final integration verification

**Files:** none (verification only).

- [ ] **Step 1: Full backend tsc**

Run: `cd app && npx tsc -p tsconfig.backend.json --noEmit`
Expected: exit 0

- [ ] **Step 2: Full frontend build**

Run: `cd app && npx vite build`
Expected: builds cleanly

- [ ] **Step 3: Full test suite**

Run: `cd app && npx vitest run`
Expected: autopilot.test.ts + world-path.test.ts all pass. The 25 pre-existing failing tests from `routes-labels`, `routes-map`, `manifest`, `pages/map` remain unchanged (not related to autopilot).

- [ ] **Step 4: Manual smoke (if game is running)**

Attach to Dofus via the UI, navigate to the State page, enter a destination mapId 3-5 hops away from the current map (use the map page or `/api/dofus/world-pathfinding/compute` to pick one), click Go. Verify:
- Panel switches to "Running" with step 1/N
- Character walks to the transition cell
- Map changes
- step counter increments
- On arrival, panel shows "✓ Arrivé"
- Clicking Go again during the same run shows the 409 reason

If a step gets stuck (e.g. arrival timeout), check the orchestrator's status via `curl http://localhost:3001/api/dofus/travel/status` to confirm the `lastError`.

- [ ] **Step 5: No additional commit** unless smoke surfaced a fix.
