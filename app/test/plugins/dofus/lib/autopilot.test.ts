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
    sendBasicPing?: TravelDeps["sendBasicPing"];
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
        movement:  {
            moveTo: vi.fn(async () => ({ ok: true, fromCell: 0, toCell: 0, mapId: 1 })),
            ...opts.movement,
        } as any,
        changeMap: { changeMap: vi.fn(async () => ({ ok: true, mapId: 1, mode: "clean" as const })), ...opts.changeMap } as any,
        sendBasicPing:    opts.sendBasicPing    ?? vi.fn(async () => ({ ok: true })),
        computeWorldPath: opts.computeWorldPath ?? (() => ({ ok: true, edges: [], iterations: 0, elapsedMs: 0 })),
        // Tests run synchronously through the loop — skip the prod settle so
        // a multi-edge happy path doesn't add 800ms per edge to the runtime.
        mapSettleMs: 0,
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

    // re-enabled in Task 5 once the edge loop actually keeps state in 'running'
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

    it("fires a BasicPing heartbeat every 5s while travel runs", async () => {
        vi.useFakeTimers();
        try {
            const player = new FakePlayer(); player.set(100, false);
            const map = new FakeMap(); map.set(1);
            const movement = { moveTo: vi.fn(async () => ({ ok: true, fromCell: 100, toCell: 200, mapId: 1 })) };
            const sendBasicPing = vi.fn(async () => ({ ok: true }));
            const deps = makeDeps({
                player, map, movement: movement as any, sendBasicPing,
                computeWorldPath: () => ({ ok: true, iterations: 0, elapsedMs: 0, edges: [walkableEdge("2", 200)] }),
            });
            const orch = new TravelOrchestrator(deps);

            const startP = orch.start(2);
            // Advance 12s while no map change fires — heartbeat should
            // have run twice (at 5s and 10s).
            await vi.advanceTimersByTimeAsync(12_000);
            expect(sendBasicPing).toHaveBeenCalledTimes(2);

            // Cancel to let the travel settle without timing out.
            orch.cancel();
            await startP;

            // After cancel, no more heartbeats fire.
            const calledOnCancel = sendBasicPing.mock.calls.length;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(sendBasicPing).toHaveBeenCalledTimes(calledOnCancel);
        } finally {
            vi.useRealTimers();
        }
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
