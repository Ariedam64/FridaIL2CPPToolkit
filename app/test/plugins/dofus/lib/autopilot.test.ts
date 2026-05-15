import { describe, it, expect, vi } from "vitest";
import { TravelOrchestrator, pickWalkable, type TravelDeps } from "../../../../plugins/dofus/lib/movement/autopilot";
import type { PathEdgeOut } from "../../../../plugins/dofus/lib/movement/world-path";

class FakePlayer {
    cell: number | null = 100;
    // `moving` retained on the fake for parity with the real PlayerState, even
    // though TravelDeps no longer queries it — the v1 loop is map-change-driven.
    moving = false;
    set(cell: number | null, moving: boolean): void {
        this.cell = cell; this.moving = moving;
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
    computeWorldPath?: TravelDeps["computeWorldPath"];
} = {}): TravelDeps {
    const player = opts.player ?? new FakePlayer();
    const map = opts.map ?? new FakeMap();
    return {
        getCurrentCell:  () => player.cell,
        getCurrentMapId: () => map.mapId,
        onMapChange:     (cb) => {
            map.listeners.push(cb);
            return () => { map.listeners = map.listeners.filter(l => l !== cb); };
        },
        movement:  { moveTo: vi.fn(async () => ({ ok: true, fromCell: 0, toCell: 0, mapId: 1 })), ...opts.movement } as any,
        computeWorldPath: opts.computeWorldPath ?? (() => ({ ok: true, edges: [], iterations: 0, elapsedMs: 0 })),
    };
}

function walkableEdge(toMapId: string, cellId: number): PathEdgeOut {
    // Type 1 = basic walk-off-edge in the cached world-graph. direction
    // is null and skillId is -1 on real walk transitions; we mirror that
    // here so the fixture matches the in-the-wild shape.
    return {
        from: { mapId: "0", zoneId: 1, uid: "v0" },
        to:   { mapId: toMapId, zoneId: 1, uid: `v${toMapId}` },
        transitions: [{ cellId, direction: null, skillId: -1, transitionMapId: toMapId, type: 1, criterion: null, id: "t" }],
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
    it("returns the first transition of type 1 or 2 (walk-off-edge)", () => {
        const t = pickWalkable([
            // zaap (type 32) — skipped
            { cellId: 1, direction: 255, skillId: 184, transitionMapId: "x", type: 32, criterion: null, id: "a" },
            // first walk match — should be returned
            { cellId: 2, direction: null, skillId: -1, transitionMapId: "x", type: 1, criterion: null, id: "b" },
            // later type-2 walk — not reached because we exit on first match
            { cellId: 3, direction: null, skillId: -1, transitionMapId: "x", type: 2, criterion: null, id: "c" },
        ]);
        expect(t).not.toBeNull();
        expect(t!.cellId).toBe(2);
    });

    it("returns null when every transition is a zaap / scroll / non-walk teleport", () => {
        const t = pickWalkable([
            { cellId: 1, direction: 255, skillId: 184, transitionMapId: "x", type: 32, criterion: null, id: "a" }, // zaap
            { cellId: 2, direction: 255, skillId: -1,  transitionMapId: "x", type: 8,  criterion: null, id: "b" }, // boat/teleport
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

    it("rejects a second start while one is running", async () => {
        // Force the orchestrator to hang in waitForMap by never firing onMapChange.
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

describe("TravelOrchestrator.start — edge loop", () => {
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    it("walks + naturally changes map across a 2-edge path", async () => {
        // The orchestrator does NOT send a change-map packet — walk-off-edge
        // transitions self-trigger the client's natural `ito`. We just drive
        // `map.set(...)` to simulate that natural transition landing.
        const player = new FakePlayer(); player.set(100, false);
        const map = new FakeMap(); map.set(1);
        const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
        const deps = makeDeps({
            player, map, movement: movement as any,
            computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [
                walkableEdge("2", 200),
                walkableEdge("3", 300),
            ]}),
        });
        const orch = new TravelOrchestrator(deps);

        const startP = orch.start(3);

        // Edge 0: after moveTo, the natural ito lands and the map switches to 2.
        await flush();
        map.set(2);
        player.set(50, false);   // entry cell on map 2
        await flush();

        // Edge 1: same shape — moveTo, then natural ito to map 3.
        await flush();
        map.set(3);
        player.set(70, false);
        await flush();

        const r = await startP;
        expect(r.ok).toBe(true);
        expect(r.totalEdges).toBe(2);
        expect(movement.moveTo).toHaveBeenCalledTimes(2);
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

    it("fails on map-change timeout (20s)", async () => {
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
            await vi.advanceTimersByTimeAsync(25_000);
            const r = await startP;

            expect(r.ok).toBe(false);
            expect(r.reason).toContain("map change timeout");
            expect(orch.getStatus().state).toBe("failed");
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("TravelOrchestrator.cancel + dispose", () => {
    async function flush(): Promise<void> {
        for (let i = 0; i < 50; i++) await Promise.resolve();
    }

    it("cancels during waitForMap → state=cancelled", async () => {
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
        expect(orch.getStatus().state).toBe("running");
        expect(movement.moveTo).toHaveBeenCalledOnce();

        const c = orch.cancel();
        expect(c.wasRunning).toBe(true);
        await startP;

        expect(orch.getStatus().state).toBe("cancelled");
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
