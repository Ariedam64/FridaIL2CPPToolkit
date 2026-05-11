// Read the live player state in one round-trip. Backend-resolved obf names
// are passed in so we survive game updates (label migration handles the
// rotation, and the resolver picks up the new obf name automatically).
//
// Instance lookups go through `getSingleton` (cached) instead of the bare
// `Il2Cpp.gc.choose` that `getLiveInstance` would do — a fresh heap scan on
// every call would stall the game. The singleton cache probes liveness on
// each read so we still catch instance turnover when it happens.

import { inVm } from "./_runtime";
import { getSingleton } from "../../../singleton-cache";

export interface PlayerStateProto {
    classes: {
        MovementController: string;
        MapRenderer:        string;
        LocalCharacter:     string;
    };
    fields: {
        MovementController_targetCellId: string;
        MapRenderer_currentMapId:        string;
        LocalCharacter_characterId:      string;
    };
}

export interface PlayerStateSnapshot {
    /** True when at least one source class is reachable. Per-field nulls
     *  signal which specific reads failed. */
    ok: boolean;
    currentMapId: number | null;
    targetCellId: number | null;
    /** Always false at init — the PlayerStore will flip it via WS updates.
     *  Kept in the snapshot for shape compatibility with the downstream
     *  store but the agent never reads it from the runtime. */
    isMoving: boolean;
    /** Int64 character id, stringified to avoid bridge bigint surprises. */
    characterId: string | null;
    /** Diagnostic string. Empty when ok=true. */
    reason?: string;
}

export function readPlayerState(proto: PlayerStateProto): Promise<PlayerStateSnapshot> {
    return inVm(() => {
        const dve = getSingleton(proto.classes.MovementController);
        const renderer = getSingleton(proto.classes.MapRenderer);
        const localChar = getSingleton(proto.classes.LocalCharacter);
        if (!dve && !renderer && !localChar) {
            return {
                ok: false, currentMapId: null, targetCellId: null, isMoving: false, characterId: null,
                reason: `no live ${proto.classes.MovementController}, ${proto.classes.MapRenderer} or ${proto.classes.LocalCharacter} instance`,
            };
        }

        let targetCellId: number | null = null;
        if (dve) {
            try { targetCellId = Number((dve as any).field(proto.fields.MovementController_targetCellId).value); } catch {}
        }

        let currentMapId: number | null = null;
        if (renderer) {
            try { currentMapId = Number((renderer as any).field(proto.fields.MapRenderer_currentMapId).value); } catch {}
        }
        // mapId comes from the wire as an Int64 — Number() is safe for the
        // observed range (< 2^53), and avoids leaking BigInt across the bridge.

        let characterId: string | null = null;
        if (localChar) {
            try { characterId = String((localChar as any).field(proto.fields.LocalCharacter_characterId).value); } catch {}
        }

        return { ok: true, currentMapId, targetCellId, isMoving: false, characterId };
    });
}
