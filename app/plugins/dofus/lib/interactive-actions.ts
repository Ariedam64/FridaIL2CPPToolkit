// Backend façade for InteractiveUseRequest (iev). The agent only sends the
// raw packet given (elementId, skillInstanceUid); this layer is responsible
// for resolving the right skillInstanceUid from the live MapInteractivesStore
// so callers never have to deal with server-allocated UIDs themselves.

import type { LabelStore } from "../../../backend/core/labels";
import type { RpcClient } from "../../../backend/core/types";
import type { MapInteractivesStore, RuntimeSkill } from "./map-interactives-store";
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
    ) {}

    private proto(): ResolvedInteractiveProto {
        return resolveProto(this.labels, INTERACTIVE_PROTO) as ResolvedInteractiveProto;
    }

    /** Use the interactive at `elementId`. If `skillId` is omitted, picks the
     *  first active skill on that element (good enough for harvestables which
     *  usually have a single gathering skill). Fails if no active skill is
     *  available — that's the server's "you can't use this" signal. */
    async useInteractive(elementId: number, skillId?: number): Promise<UseInteractiveResult> {
        const mapId = this.mapInteractives.getCurrentMapId();
        if (mapId === null) return { ok: false, elementId, reason: "no map seen yet — change map once after attaching" };
        const map = this.mapInteractives.getMap(mapId);
        if (!map) return { ok: false, elementId, reason: `no runtime data for current map ${mapId}` };
        const interactive = map.interactives.find((i) => i.elementId === elementId);
        if (!interactive) return { ok: false, elementId, reason: `elementId ${elementId} not on current map ${mapId}` };

        let skill: RuntimeSkill | undefined;
        if (skillId !== undefined) {
            skill = interactive.skills.find((s) => s.skillId === skillId && s.active);
            if (!skill) return { ok: false, elementId, reason: `no active skill ${skillId} on element ${elementId}` };
        } else {
            skill = interactive.skills.find((s) => s.active);
            if (!skill) return { ok: false, elementId, reason: `no active skill on element ${elementId} (wrong job/level, or already busy)` };
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
