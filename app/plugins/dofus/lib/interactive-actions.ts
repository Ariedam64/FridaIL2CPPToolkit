// Backend façade for InteractiveUseRequest (iev). The agent only sends the
// raw packet given (elementId, skillInstanceUid); this layer resolves the
// right skillInstanceUid from MapStateStore — the live in-RAM mirror of the
// current itx — so callers never have to deal with the server-allocated
// ephemeral UIDs themselves.
//
// Why MapStateStore and not MapInteractivesStore: the persisted runtime DB
// is now slim (identification only — no UIDs, no active flag). UIDs are
// ephemeral per-itx and live exclusively in MapStateStore.

import type { LabelStore } from "../../../backend/core/labels";
import type { RpcClient } from "../../../backend/core/types";
import type { MapInteractivesStore } from "./map-interactives-store";
import type { MapStateStore } from "./map-state-store";
import { INTERACTIVE_PROTO, type ResolvedInteractiveProto } from "./protocol";
import { resolveProto } from "./protocol-resolver";

export interface UseInteractiveResult {
    ok: boolean;
    /** Echoed back so the caller can correlate. */
    elementId: number;
    /** Skill we ended up using (resolved from the store). */
    skillId?: number;
    skillName?: string;
    skillInstanceUid?: number;
    reason?: string;
}

interface SendResult { ok: boolean; reason?: string }

export class InteractiveActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
        private readonly mapInteractives: MapInteractivesStore,
        private readonly mapStateStore: MapStateStore,
    ) {}

    private proto(): ResolvedInteractiveProto {
        return resolveProto(this.labels, INTERACTIVE_PROTO) as ResolvedInteractiveProto;
    }

    /** Use the interactive at `elementId`. If `skillId` is omitted, picks the
     *  first enabled skill on that element (good enough for harvestables
     *  which usually have a single gathering skill). Fails if no enabled
     *  skill is available — that's the server's "you can't use this" signal
     *  (wrong job/level, already busy, etc.). */
    async useInteractive(elementId: number, skillId?: number): Promise<UseInteractiveResult> {
        const state = this.mapStateStore.getState();
        if (state.mapId === null) {
            return { ok: false, elementId, reason: "no map seen yet — change map once after attaching" };
        }
        const live = state.interactables.find((i) => i.elementId === elementId);
        if (!live) return { ok: false, elementId, reason: `elementId ${elementId} not on current map ${state.mapId}` };

        const skill = skillId !== undefined
            ? live.enabledSkills.find((s) => s.skillId === skillId)
            : live.enabledSkills[0];
        if (!skill) {
            const reason = skillId !== undefined
                ? `no enabled skill ${skillId} on element ${elementId}`
                : `no enabled skill on element ${elementId} (wrong job/level, or already busy)`;
            return { ok: false, elementId, reason };
        }

        const proto = this.proto();
        const send = await this.rpc.call<SendResult>("sendUseInteractive", [proto, elementId, skill.skillInstanceUid]);
        const skillCatalog = this.mapInteractives.skillEntry(skill.skillId);
        const skillName = skillCatalog
            ? (skillCatalog.gatheredItem ? `${skillCatalog.name} (${skillCatalog.gatheredItem.name})` : skillCatalog.name)
            : undefined;
        return {
            ok: send.ok,
            elementId,
            skillId: skill.skillId,
            skillName,
            skillInstanceUid: skill.skillInstanceUid,
            reason: send.reason,
        };
    }
}
