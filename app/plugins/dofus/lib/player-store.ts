// Mirror of the player's in-game state. Scoped to "things about the player
// themselves" — mapId/entity list live in `MapStateStore`.
//
// Lifecycle:
//   1. INIT — at construction, ONE agent read (`readPlayerState`) bootstraps
//      the snapshot from the live IL2CPP runtime. We attach mid-session so
//      the client is the only source of truth for the initial values.
//   2. UPDATE — driven by network frames captured on the WS layer. Each
//      handler patches a single field; no agent round-trip.
//
// WS-driven mutations:
//   - MapEntityMovement (itv, incoming) → on our entityId only:
//        targetCellId := last(cellPath), cellPath := parsed, isMoving := true
//   - MoveStop          (itr, outgoing) → currentCellId := last(cellPath),
//        cellPath := [], isMoving := false
//
// Init mapping:
//   targetCellId  ← MovementController.targetCellId
//   currentCellId ← MovementController.targetCellId  (assumed stationary)
//   isMoving      ← false
//   characterId   ← LocalCharacter.characterId
//   cellPath      ← []

import type { Session } from "../../../backend/session";
import type { LabelStore } from "../../../backend/core/labels";
import type { RpcClient } from "../../../backend/core/types";
import type { NetworkFrame, FrameField } from "../../../backend/core/network/types";
import { PLAYER_STATE_PROTO, type ResolvedPlayerStateProto } from "./protocol";
import { resolveProto } from "./protocol-resolver";
import { findField, intFromField } from "./frame-await";

/** Read every Int child of a RepeatedField<int>-shaped frame field. Returns
 *  an empty array when the field is missing/empty, and silently skips any
 *  child whose preview can't be parsed as an int (defensive — the network
 *  monitor occasionally emits "…" sentinels for clipped lists). */
function parseIntArrayChildren(field: FrameField | undefined): number[] {
    if (!field?.children) return [];
    const out: number[] = [];
    for (const c of field.children) {
        const n = intFromField(c);
        if (n !== null) out.push(n);
    }
    return out;
}

export interface PlayerState {
    /** Cell the player is physically on. Locked at init to the targetCellId
     *  (assumed stationary). On move-end (itr) it's snapped to the last cell
     *  of the in-flight cellPath. */
    currentCellId: number | null;
    /** Cell the move is heading toward. Init = dve.dezz; updated on each
     *  outgoing itv to the last cell of the new path. */
    targetCellId: number | null;
    /** Full path the player is currently following, raw cell ids, in order
     *  (cellPath[0] = start, cellPath[last] = destination). Empty when
     *  stationary. Source = the itv frame `cellPath` array. */
    cellPath: number[];
    /** True from the itv that starts a move until the itr that ends it. */
    isMoving: boolean;
    /** Stable Int64 ID of the local character (set on login, constant for the
     *  session). Returned as string to side-step JS-side bigint marshaling. */
    characterId: string | null;
}

interface AgentSnapshot {
    ok: boolean;
    targetCellId: number | null;
    isMoving: boolean;
    characterId: string | null;
    reason?: string;
}

type Listener = (state: PlayerState) => void;

const NULL_STATE: PlayerState = {
    currentCellId: null, targetCellId: null,
    cellPath: [], isMoving: false, characterId: null,
};

export class PlayerStore {
    private state: PlayerState = { ...NULL_STATE };
    private listeners: Listener[] = [];
    private inflightRefresh: Promise<void> | null = null;
    private pendingRefresh = false;
    private disposers: Array<() => void> = [];
    /** Cached resolved proto — recomputed whenever a label changes so the
     *  WS-frame handlers always match against the up-to-date obf names. */
    private resolvedProto: ResolvedPlayerStateProto;

    constructor(
        private readonly session: Session,
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
    ) {
        this.resolvedProto = this.computeProto();

        const onFrame = (frame: NetworkFrame): void => { this.handleFrame(frame); };
        this.session.on("network-frame-added", onFrame);
        this.disposers.push(() => this.session.off("network-frame-added", onFrame));

        // Re-resolve obf names whenever a label changes — survives an in-session
        // rename (and, more practically, post-migration relabeling).
        const onLabelChange = (): void => { this.resolvedProto = this.computeProto(); };
        this.session.on("label-change", onLabelChange);
        this.disposers.push(() => this.session.off("label-change", onLabelChange));
    }

    dispose(): void {
        for (const d of this.disposers) { try { d(); } catch {} }
        this.disposers = [];
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

    private computeProto(): ResolvedPlayerStateProto {
        return resolveProto(this.labels, PLAYER_STATE_PROTO) as ResolvedPlayerStateProto;
    }

    /** Network-frame router. Dispatches to the per-class handler whose
     *  resolved obf name matches the frame. Cheap: O(1) lookup per frame. */
    private handleFrame(frame: NetworkFrame): void {
        const cn = frame.typeKey.className;
        const cls = this.resolvedProto.classes;
        if (cn === cls.MapEntityMovement)  this.handleEntityMovement(frame);
        else if (cn === cls.MoveStop)      this.handleMoveStop();
    }

    /** itv (mapEntityMovement) — server broadcasts every entity's move.
     *  We only care about our own (filter by entityId === characterId).
     *  Carries the cellPath we're about to follow → targetCellId + isMoving. */
    private handleEntityMovement(frame: NetworkFrame): void {
        const myId = this.state.characterId;
        if (!myId) return;
        const entIdField = findField(frame.fields, this.resolvedProto.fields.MapEntityMovement_entityId);
        // entityId is Int64 → arrives as a stringified number in `preview`.
        if (!entIdField || entIdField.preview !== myId) return;

        const pathField = findField(frame.fields, this.resolvedProto.fields.MapEntityMovement_cellPath);
        const cellPath = parseIntArrayChildren(pathField);
        if (cellPath.length === 0) return;
        const targetCellId = cellPath[cellPath.length - 1];

        this.state = {
            ...this.state,
            cellPath,
            targetCellId,
            isMoving: true,
        };
        this.emit();
    }

    /** itr (MoveStop) — client tells the server the move is over. The frame
     *  has no payload; we just commit the in-flight cellPath's destination
     *  to currentCellId and clear the path. */
    private handleMoveStop(): void {
        const path = this.state.cellPath;
        const dest = path.length > 0 ? path[path.length - 1] : this.state.targetCellId;
        // If we somehow got an itr without a preceding itv (e.g. cancelled
        // before the broadcast landed) the current cell stays where it was.
        if (!this.state.isMoving && this.state.cellPath.length === 0 && this.state.currentCellId === dest) return;

        this.state = {
            ...this.state,
            currentCellId: dest,
            cellPath: [],
            isMoving: false,
        };
        this.emit();
    }

    private async doRefresh(): Promise<void> {
        const proto = this.resolvedProto;
        let snap: AgentSnapshot;
        try {
            snap = await this.rpc.call<AgentSnapshot>("readPlayerState", [proto]);
        } catch {
            return;  // agent unavailable / detached — keep last-known state
        }
        if (!snap || !snap.ok) return;

        const next: PlayerState = {
            // Both cell fields mirror the read targetCellId at init: the
            // player is assumed stationary, so where they last clicked is
            // where they are. isMoving is hardcoded false for the same reason.
            currentCellId: snap.targetCellId,
            targetCellId: snap.targetCellId,
            cellPath: [],
            isMoving: false,
            characterId: snap.characterId ?? this.state.characterId,
        };
        if (this.diff(this.state, next)) {
            this.state = next;
            this.emit();
        }
    }

    private diff(a: PlayerState, b: PlayerState): boolean {
        if (a.currentCellId !== b.currentCellId) return true;
        if (a.targetCellId !== b.targetCellId) return true;
        if (a.isMoving !== b.isMoving) return true;
        if (a.characterId !== b.characterId) return true;
        if (a.cellPath.length !== b.cellPath.length) return true;
        for (let i = 0; i < a.cellPath.length; i++) {
            if (a.cellPath[i] !== b.cellPath[i]) return true;
        }
        return false;
    }

    private emit(): void {
        const snap = this.getState();
        for (const l of this.listeners) {
            try { l(snap); } catch (e) { console.warn("[player-store] listener threw:", e); }
        }
    }
}
