// Mirror of the player's in-game state.
//
// Lifecycle (current phase: INIT-ONLY):
//   - At construction, the store performs ONE agent read (`readPlayerState`)
//     to bootstrap from the live IL2CPP runtime — we attach mid-session so
//     we've missed the login WS messages and the client is the only source
//     of truth for current values.
//   - After init, the state stays static. Updates will be wired in a
//     follow-up pass driven by WS messages (each move/cancel/end packet
//     mutates the relevant fields). For now `refresh()` is still exposed
//     so the bot can request a re-init manually if needed.
//
// Init mapping:
//   currentMapId  ← MapRenderer.currentMapId
//   targetCellId  ← MovementController.targetCellId
//   currentCellId ← MovementController.targetCellId  (player is stationary
//                                                    at attach; the cell
//                                                    where they last clicked
//                                                    is where they are now)
//   isMoving      ← false  (conservative; assumes stationary at attach)
//   characterId   ← LocalCharacter.characterId

import type { Session } from "../../../backend/session";
import type { LabelStore } from "../../../backend/core/labels";
import type { RpcClient } from "../../../backend/core/types";
import { PLAYER_STATE_PROTO, type ResolvedPlayerStateProto } from "./protocol";
import { resolveProto } from "./protocol-resolver";

export interface PlayerState {
    /** Int64 mapId from MapRenderer. */
    currentMapId: number | null;
    /** Cell the player is physically on. At init this mirrors `targetCellId`
     *  (assumes stationary). Updates will diverge from `targetCellId` during
     *  movement once WS-driven updates are wired. */
    currentCellId: number | null;
    /** Last cell the player clicked / targeted (from `dve.dezz`). */
    targetCellId: number | null;
    /** True from the moment the player clicks until the server confirms arrival.
     *  Init: always false (we assume stationary at attach). */
    isMoving: boolean;
    /** Stable Int64 ID of the local character (set on login, constant for the
     *  session). Returned as string to side-step JS-side bigint marshaling. */
    characterId: string | null;
}

interface AgentSnapshot {
    ok: boolean;
    currentMapId: number | null;
    targetCellId: number | null;
    isMoving: boolean;
    characterId: string | null;
    reason?: string;
}

type Listener = (state: PlayerState) => void;

const NULL_STATE: PlayerState = {
    currentMapId: null, currentCellId: null, targetCellId: null,
    isMoving: false, characterId: null,
};

export class PlayerStore {
    private state: PlayerState = { ...NULL_STATE };
    private listeners: Listener[] = [];
    private inflightRefresh: Promise<void> | null = null;
    private pendingRefresh = false;

    constructor(
        // The session ref is kept for the WS-update phase coming next — we'll
        // reattach `network-frame-added` here once the update protocol is
        // wired. Currently unused beyond holding the reference.
        private readonly _session: Session,
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
    ) {}

    dispose(): void {
        this.listeners = [];
    }

    getState(): PlayerState {
        return { ...this.state };
    }

    onChange(cb: Listener): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Re-read every field from the IL2CPP runtime. Used at init and exposed
     *  for manual re-bootstrap. Coalesces overlapping calls. */
    async refresh(): Promise<void> {
        if (this.inflightRefresh) {
            this.pendingRefresh = true;
            return this.inflightRefresh;
        }
        this.inflightRefresh = this.doRefresh()
            .finally(() => {
                this.inflightRefresh = null;
                if (this.pendingRefresh) {
                    this.pendingRefresh = false;
                    void this.refresh();
                }
            });
        return this.inflightRefresh;
    }

    private async doRefresh(): Promise<void> {
        const proto = resolveProto(this.labels, PLAYER_STATE_PROTO) as ResolvedPlayerStateProto;
        let snap: AgentSnapshot;
        try {
            snap = await this.rpc.call<AgentSnapshot>("readPlayerState", [proto]);
        } catch {
            return;  // agent unavailable / detached — keep last-known state
        }
        if (!snap || !snap.ok) return;

        const next: PlayerState = {
            currentMapId: snap.currentMapId,
            // Both cell fields mirror the read targetCellId at init: the
            // player is assumed stationary, so where they last clicked is
            // where they are. isMoving is hardcoded false for the same reason.
            currentCellId: snap.targetCellId,
            targetCellId: snap.targetCellId,
            isMoving: false,
            characterId: snap.characterId ?? this.state.characterId,
        };
        if (this.diff(this.state, next)) {
            this.state = next;
            this.emit();
        }
    }

    private diff(a: PlayerState, b: PlayerState): boolean {
        return a.currentMapId !== b.currentMapId
            || a.currentCellId !== b.currentCellId
            || a.targetCellId !== b.targetCellId
            || a.isMoving     !== b.isMoving
            || a.characterId  !== b.characterId;
    }

    private emit(): void {
        const snap = this.getState();
        for (const l of this.listeners) {
            try { l(snap); } catch (e) { console.warn("[player-store] listener threw:", e); }
        }
    }
}
