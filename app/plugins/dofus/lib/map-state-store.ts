// Live mirror of the current map's authoritative state (mapId + entity list).
//
// Lifecycle:
//   1. INIT — at construction we read `MapRenderer.currentMapId` via the
//      agent (the only client-side source for the active map), then forge
//      an `isp(mapId)` packet. The server reacts by re-broadcasting an
//      `itx` for the current map — this gives us the FULL initial entity
//      list without waiting for a natural map change.
//   2. UPDATE — every subsequent `itx` (map change, fight enter, etc.)
//      lands on the network monitor; we parseItx() and replace the state.
//
// State shape:
//   mapId          — Int64 from itx (or the synthetic isp's seed at init)
//   entities       — list of { entityId, cellId, name, level } extracted
//                    from itx.eftd via the EntityLook → CharacterAttributes
//                    → CharacterCard → name + (progression → levelInfo → level)
//                    chain. NPCs/monsters lack the deeper character data so
//                    `name` / `level` come back null for them.

import type { Session } from "../../../backend/session";
import type { LabelStore } from "../../../backend/core/labels";
import type { RpcClient } from "../../../backend/core/types";
import type { NetworkFrame } from "../../../backend/core/network/types";
import { MAP_STATE_PROTO, type ResolvedMapStateProto } from "./protocol";
import { resolveProto } from "./protocol-resolver";
import { parseItx, DEFAULT_ITX_OBF, type ItxObfNames } from "./itx-parser";

export interface MapEntitySnapshot {
    entityId: string;
    cellId: number | null;
    name: string | null;
    level: number | null;
}

export interface MapInteractableSkill {
    skillId: number;
    skillInstanceUid: number;
}

/** Server-visible interactable (resource node, NPC, zaap, etc.) on the
 *  current map. Built by joining `itx.statedElements` (filtered to
 *  `onCurrentMap = true`) with `itx.interactives` by elementId.
 *
 *  Two orthogonal booleans encode whether the bot can act on it right now:
 *    - `isReady`    — server-side state: the resource is mature / off cooldown
 *    - `canHarvest` — player-side state: we have a usable skill (right job
 *                    + level). Tied to the `enabledSkills` bucket.
 *  A bot can act when BOTH are true. They diverge in real plays — e.g. a
 *  mature bamboo on a paysan-only map shows `isReady && !canHarvest`. */
export interface MapInteractable {
    elementId: number;
    cellId: number | null;
    interactiveTypeId: number;
    /** Harvest cooldown state. 0 = ready, ≥1 = ticks until refresh. Non-
     *  harvestable interactables (zaap, NPC dialogue) keep this at 0. */
    state: number;
    enabledSkills:  MapInteractableSkill[];
    disabledSkills: MapInteractableSkill[];
    /** Derived: `state === 0`. The resource is mature / off cooldown. */
    isReady: boolean;
    /** Derived: `enabledSkills.length > 0`. The player has the right job +
     *  level to interact with this element. Disabled skills are surfaced
     *  separately so the bot can detect "we'd be able to harvest if X". */
    canHarvest: boolean;
}

export interface MapState {
    mapId: number | null;
    entities: MapEntitySnapshot[];
    interactables: MapInteractable[];
}

type Listener = (state: MapState) => void;

const NULL_STATE: MapState = { mapId: null, entities: [], interactables: [] };

interface AgentMapIdSnapshot { ok: boolean; mapId: number | null; reason?: string }

export class MapStateStore {
    private state: MapState = { ...NULL_STATE };
    private listeners: Listener[] = [];
    private disposers: Array<() => void> = [];
    private resolvedProto: ResolvedMapStateProto;

    constructor(
        private readonly session: Session,
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
    ) {
        this.resolvedProto = this.computeProto();

        const onFrame = (frame: NetworkFrame): void => { this.handleFrame(frame); };
        this.session.on("network-frame-added", onFrame);
        this.disposers.push(() => this.session.off("network-frame-added", onFrame));

        const onLabelChange = (): void => { this.resolvedProto = this.computeProto(); };
        this.session.on("label-change", onLabelChange);
        this.disposers.push(() => this.session.off("label-change", onLabelChange));
    }

    dispose(): void {
        for (const d of this.disposers) { try { d(); } catch {} }
        this.disposers = [];
        this.listeners = [];
    }

    getState(): MapState {
        return {
            mapId: this.state.mapId,
            entities: [...this.state.entities],
            interactables: [...this.state.interactables],
        };
    }

    onChange(cb: Listener): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    /** Init flow: read the current mapId from the runtime, then forge an isp
     *  so the server re-broadcasts an itx (which our `handleFrame` will
     *  parse). Safe to call any time — e.g. after a profile reattach. */
    async bootstrap(): Promise<void> {
        let mapId: number | null = null;
        try {
            const snap = await this.rpc.call<AgentMapIdSnapshot>("readMapState", [{
                classes: { MapRenderer: this.resolvedProto.classes.MapRenderer },
                fields:  { MapRenderer_currentMapId: this.resolvedProto.fields.MapRenderer_currentMapId },
            }]);
            if (snap?.ok) mapId = snap.mapId;
        } catch { /* agent not reachable yet — keep null */ }

        // Pre-fill mapId so consumers can read it before the itx arrives.
        if (mapId !== null && this.state.mapId !== mapId) {
            this.state = { ...this.state, mapId };
            this.emit();
        }
        if (mapId === null) return;

        // Forge the isp. We borrow the shape that `sendMapEnteredNotification`
        // (in change-map.ts) expects — same proto on the wire, just renamed
        // keys on this side of the RPC.
        try {
            await this.rpc.call("sendMapEnteredNotification", [{
                classes: {
                    MapEnteredNotif: this.resolvedProto.classes.MapEnteredNotification,
                    Dispatcher:      this.resolvedProto.classes.Dispatcher,
                },
                fields: {
                    MapEnteredNotif_flag1: this.resolvedProto.fields.MapEnteredNotification_flag1,
                    MapEnteredNotif_mapId: this.resolvedProto.fields.MapEnteredNotification_mapId,
                },
                methods: { Dispatcher_send: this.resolvedProto.methods.Dispatcher_send },
            }, mapId]);
        } catch { /* send failed — natural itx on next map change will recover */ }
    }

    // ------------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------------

    private computeProto(): ResolvedMapStateProto {
        return resolveProto(this.labels, MAP_STATE_PROTO) as ResolvedMapStateProto;
    }

    /** itx-parser uses a small ObfNames record; we project the resolved proto
     *  into that shape (mostly a rename). Anything not in MAP_STATE_PROTO
     *  defaults to the parser's hardcoded fallback. */
    private currentItxObfNames(): ItxObfNames {
        const f = this.resolvedProto.fields;
        const c = this.resolvedProto.classes;
        return {
            ...DEFAULT_ITX_OBF,
            className:                          c.MapInfo,
            mapId:                              f.MapInfo_mapId,
            entitiesArray:                      f.MapInfo_entities,
            entity_entityId:                    f.MapEntity_entityId,
            entity_position:                    f.MapEntity_position,
            position_cellId:                    f.EntityPosition_cellId,
            entity_look:                        f.MapEntity_look,
            look_characterAttributes:           f.EntityLook_characterAttributes,
            characterAttributes_characterCard:  f.CharacterAttributes_characterCard,
            characterCard_name:                 f.CharacterCard_name,
            characterCard_progression:          f.CharacterCard_progression,
            progression_levelInfo:              f.CharacterProgression_levelInfo,
            levelInfo_level:                    f.LevelInfo_level,
            // Interactables join.
            interactivesArray:                  f.MapInfo_interactives,
            statedElementsArray:                f.MapInfo_statedElements,
            interactiveElementId:               f.InteractiveElement_elementId,
            interactiveTypeId:                  f.InteractiveElement_interactiveTypeId,
            interactiveSkillsActive:            f.InteractiveElement_enabledSkills,
            interactiveSkillsDisabled:          f.InteractiveElement_disabledSkills,
            skillId:                            f.InteractiveElementSkill_skillId,
            skillInstanceUid:                   f.InteractiveElementSkill_skillInstanceUid,
            statedElement_state:                f.StatedElement_state,
            statedElement_onCurrentMap:         f.StatedElement_onCurrentMap,
            statedElement_elementId:            f.StatedElement_elementId,
            statedElement_cell:                 f.StatedElement_cell,
        };
    }

    private handleFrame(frame: NetworkFrame): void {
        if (frame.typeKey.className !== this.resolvedProto.classes.MapInfo) return;
        const parsed = parseItx(frame, this.currentItxObfNames());
        if (!parsed) return;

        const entities: MapEntitySnapshot[] = parsed.entities.map((e) => ({
            entityId: e.entityId, cellId: e.cellId, name: e.name, level: e.level,
        }));

        // Interactables = (statedElements where onCurrentMap=true) ⨝ interactives
        // on elementId. The stated entry brings the live cellId + cooldown state;
        // the interactives entry brings the skill lists. Static map decor that
        // has an interactive entry but no stated entry (NPCs, zaaps, etc.) is
        // also surfaced — the absence of a stated record just means there's no
        // harvest cooldown to track.
        const statedByElementId = new Map<number, typeof parsed.statedElements[number]>();
        for (const se of parsed.statedElements) statedByElementId.set(se.elementId, se);

        const interactables: MapInteractable[] = [];
        for (const i of parsed.interactives) {
            const se = statedByElementId.get(i.elementId);
            // Skip ghosts — the server announces neighbouring-map interactives
            // for visual continuity but they're not actionable from here.
            if (se && !se.onCurrentMap) continue;
            const enabledSkills:  MapInteractableSkill[] = [];
            const disabledSkills: MapInteractableSkill[] = [];
            for (const s of i.skills) {
                const bucket = s.active ? enabledSkills : disabledSkills;
                bucket.push({ skillId: s.skillId, skillInstanceUid: s.skillInstanceUid });
            }
            const state = se ? se.state : 0;
            interactables.push({
                elementId: i.elementId,
                cellId: se ? se.cell : null,
                interactiveTypeId: i.typeId,
                state,
                enabledSkills,
                disabledSkills,
                isReady: state === 0,
                canHarvest: enabledSkills.length > 0,
            });
        }

        const next: MapState = { mapId: parsed.mapId, entities, interactables };
        if (!this.diff(this.state, next)) return;
        this.state = next;
        this.emit();
    }

    private diff(a: MapState, b: MapState): boolean {
        if (a.mapId !== b.mapId) return true;
        if (a.entities.length !== b.entities.length) return true;
        for (let i = 0; i < a.entities.length; i++) {
            const ea = a.entities[i], eb = b.entities[i];
            if (ea.entityId !== eb.entityId) return true;
            if (ea.cellId !== eb.cellId) return true;
            if (ea.name !== eb.name) return true;
            if (ea.level !== eb.level) return true;
        }
        if (a.interactables.length !== b.interactables.length) return true;
        for (let i = 0; i < a.interactables.length; i++) {
            const ia = a.interactables[i], ib = b.interactables[i];
            if (ia.elementId !== ib.elementId) return true;
            if (ia.cellId !== ib.cellId) return true;
            if (ia.interactiveTypeId !== ib.interactiveTypeId) return true;
            if (ia.state !== ib.state) return true;
            if (ia.isReady !== ib.isReady) return true;
            if (ia.canHarvest !== ib.canHarvest) return true;
            if (ia.enabledSkills.length !== ib.enabledSkills.length) return true;
            if (ia.disabledSkills.length !== ib.disabledSkills.length) return true;
        }
        return false;
    }

    private emit(): void {
        const snap = this.getState();
        for (const l of this.listeners) {
            try { l(snap); } catch (e) { console.warn("[map-state] listener threw:", e); }
        }
    }
}
