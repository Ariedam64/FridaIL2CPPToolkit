import { describe, it, expect, vi } from "vitest";
import { TravelOrchestrator, pickWalkable, type TravelDeps } from "../../../../plugins/dofus/lib/movement/autopilot";
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

    // re-enabled in Task 5 once the edge loop actually keeps state in 'running'
    it.skip("rejects a second start while one is running", async () => {
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
