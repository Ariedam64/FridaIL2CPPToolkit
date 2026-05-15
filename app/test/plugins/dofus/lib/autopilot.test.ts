import { describe, it, expect, vi } from "vitest";
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
