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
import { computeCellPath, decodeKeyMovement } from "./pathfinder";

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
    reason?: string;
}

interface SendResult { ok: boolean; reason?: string }

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

    /** Compute the path + send the isa frame. */
    async moveTo(fromCell: number, toCell: number, mapId?: number): Promise<MoveResult> {
        const ctx = await this.resolveMapAndCells(mapId);
        if ("reason" in ctx) return { ok: false, fromCell, toCell, reason: ctx.reason };
        const result = computeCellPath(fromCell, toCell, ctx.cells);
        if (!result.ok) return { ok: false, fromCell, toCell, mapId: ctx.mapId, reason: result.reason };

        const proto = this.proto();
        const send = await this.rpc.call<SendResult>("sendMapMoveRequest", [proto, result.keyMovements, ctx.mapId]);
        return {
            ok: send.ok, fromCell, toCell, mapId: ctx.mapId,
            path: result.path,
            keyMovements: result.keyMovements,
            pivots: result.keyMovements.map(decodeKeyMovement),
            reason: send.reason,
        };
    }

    /** Forge a confirmMoveEnd (ish) packet. Ack to the server's MoveStop
     *  (itr) — must be sent before any follow-up packet (e.g. a moveToNewMap
     *  for map change) once the server signals the move has ended. */
    async confirmMoveEnd(): Promise<SendResult> {
        return this.rpc.call<SendResult>("sendConfirmMoveEnd", [this.proto()]);
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
