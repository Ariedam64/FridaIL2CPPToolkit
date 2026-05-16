// Backend façade for MapMoveRequest (isa). Computes the path with
// pathfinder.ts using the static map cell grid, then dispatches the agent
// RPC. The caller passes (fromCell, toCell) — we don't track player
// position yet, so the start cell has to be supplied externally for now.

import type { LabelStore } from "../../../../backend/core/labels";
import type { RpcClient } from "../../../../backend/core/types";
import type { DofusDataStore } from "../stores/data";
import type { MapInteractivesStore } from "../stores/map-interactives";
import { MOVEMENT_PROTO, type ResolvedMovementProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";
import { computeCellPath, decodeKeyMovement, findWalkableNeighbour } from "./pathfinder";

export interface MoveResult {
    ok: boolean;
    mapId?: number;
    fromCell: number;
    toCell: number;
    /** Every cell traversed (start to end inclusive) — useful for previewing
     *  the route before committing to it. */
    path?: number[];
    /** What got sent on the wire (or would be for compute-only). */
    keyMovements?: number[];
    /** Decoded keyMovements for human consumption. */
    pivots?: { cellId: number; direction: number }[];
    /** Diagnostic timings, populated for moveTo/stopMoving. */
    timings?: {
        /** Host → agent RPC roundtrip (= total wall-clock seen by the autopilot). */
        rpcTotalMs: number;
        /** Inside the agent perform: build the IL2CPP message. */
        agentBuildMs?: number;
        /** Inside the agent perform: dispatcher.send call. */
        agentSendMs?: number;
        /** Inside the agent perform: total time in Il2Cpp.perform. */
        agentTotalMs?: number;
    };
    reason?: string;
}

interface AgentTimings { buildMs: number; sendMs: number; totalMs: number }

interface SendResult { ok: boolean; reason?: string; timings?: AgentTimings }

export class MovementActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
        private readonly mapInteractives: MapInteractivesStore,
        private readonly dataStore: DofusDataStore,
    ) {}

    private proto(): ResolvedMovementProto {
        return resolveProto(this.labels, MOVEMENT_PROTO) as ResolvedMovementProto;
    }

    /** Compute the path without sending it — useful for UI previews and
     *  for sanity-checking the encoder offline. */
    async computePath(fromCell: number, toCell: number, mapId?: number): Promise<MoveResult> {
        const ctx = await this.resolveMapAndCells(mapId);
        if ("reason" in ctx) return { ok: false, fromCell, toCell, reason: ctx.reason };
        const result = computeCellPath(fromCell, toCell, ctx.cells);
        if (!result.ok) return { ok: false, fromCell, toCell, mapId: ctx.mapId, reason: result.reason };
        return {
            ok: true, fromCell, toCell, mapId: ctx.mapId,
            path: result.path,
            keyMovements: result.keyMovements,
            pivots: result.keyMovements.map(decodeKeyMovement),
        };
    }

    /** Return a cell from which `targetCell` is reachable by a 1-cell
     *  interaction range. If `targetCell` is walkable we just return it; if
     *  not (door, ladder, hole on a non-walkable cell), we return its first
     *  walkable neighbour. Null = no approach found (target isolated). */
    async findApproach(targetCell: number, mapId?: number): Promise<{ ok: boolean; cell?: number; reason?: string }> {
        const ctx = await this.resolveMapAndCells(mapId);
        if ("reason" in ctx) return { ok: false, reason: ctx.reason };
        if (ctx.cells[targetCell] && (ctx.cells[targetCell]![0] & 1) !== 0 && (ctx.cells[targetCell]![0] & 8) === 0) {
            return { ok: true, cell: targetCell };
        }
        const neighbour = findWalkableNeighbour(targetCell, ctx.cells);
        if (neighbour === null) return { ok: false, reason: `no walkable cell adjacent to ${targetCell} on map ${ctx.mapId}` };
        return { ok: true, cell: neighbour };
    }

    /** Forge a MoveStop (itr) packet — used by the autopilot as a watchdog
     *  when the client's local walker stalls. Server replies with `ish`,
     *  which flips PlayerStore.isMoving=false and unblocks waitForArrival. */
    async stopMoving(): Promise<SendResult> {
        const tStart = Date.now();
        const r = await this.rpc.call<SendResult>("sendMoveStop", [this.proto()]);
        const rpcTotalMs = Date.now() - tStart;
        console.log(`[movement] stopMoving rpc=${rpcTotalMs}ms agent_build=${r.timings?.buildMs ?? "?"}ms agent_send=${r.timings?.sendMs ?? "?"}ms agent_total=${r.timings?.totalMs ?? "?"}ms`);
        return r;
    }

    /** Compute the path + send the isa frame. */
    async moveTo(fromCell: number, toCell: number, mapId?: number): Promise<MoveResult> {
        const ctx = await this.resolveMapAndCells(mapId);
        if ("reason" in ctx) return { ok: false, fromCell, toCell, reason: ctx.reason };
        const result = computeCellPath(fromCell, toCell, ctx.cells);
        if (!result.ok) return { ok: false, fromCell, toCell, mapId: ctx.mapId, reason: result.reason };

        const proto = this.proto();
        const tStart = Date.now();
        const send = await this.rpc.call<SendResult>("sendMapMoveRequest", [proto, result.keyMovements, ctx.mapId]);
        const rpcTotalMs = Date.now() - tStart;
        console.log(`[movement] moveTo isa rpc=${rpcTotalMs}ms agent_build=${send.timings?.buildMs ?? "?"}ms agent_send=${send.timings?.sendMs ?? "?"}ms agent_total=${send.timings?.totalMs ?? "?"}ms (km=${result.keyMovements.length})`);
        return {
            ok: send.ok, fromCell, toCell, mapId: ctx.mapId,
            path: result.path,
            keyMovements: result.keyMovements,
            pivots: result.keyMovements.map(decodeKeyMovement),
            timings: {
                rpcTotalMs,
                agentBuildMs: send.timings?.buildMs,
                agentSendMs:  send.timings?.sendMs,
                agentTotalMs: send.timings?.totalMs,
            },
            reason: send.reason,
        };
    }


    private async resolveMapAndCells(mapId?: number): Promise<
        | { mapId: number; cells: ReadonlyArray<readonly [number, number, number, number, number] | undefined> }
        | { reason: string }
    > {
        const id = mapId ?? this.mapInteractives.getCurrentMapId();
        if (id === null || id === undefined) return { reason: "no map seen yet — change map once after attaching" };
        const detail = await this.dataStore.loadMapDetail(id);
        if (!detail) return { reason: `map ${id} not found in static data` };
        return { mapId: id, cells: detail.cells };
    }
}
