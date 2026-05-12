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
import type { FrameField } from "../../../backend/core/network/types";
import { parseItx, parseStateUpdate, parseNewPlayerOnMap, parsePlayerLeaveMap, parseEntityMovement, DEFAULT_ITX_OBF, type ItxObfNames } from "./itx-parser";
import { findField, intFromField } from "./frame-await";

/** Parse a RepeatedField<knc> child list into MapInteractableSkill[]. Skips
 *  rows where either id is missing (defensive — clipped previews). */
function readSkillsFromList(arr: FrameField, skillIdObf: string, skillInstanceUidObf: string): MapInteractableSkill[] {
    if (!arr.children) return [];
    const out: MapInteractableSkill[] = [];
    for (const knc of arr.children) {
        if (knc.name === "…" || !knc.children) continue;
        const skillId = intFromField(findField(knc.children, skillIdObf));
        const skillInstanceUid = intFromField(findField(knc.children, skillInstanceUidObf));
        if (skillId === null || skillInstanceUid === null) continue;
        out.push({ skillId, skillInstanceUid });
    }
    return out;
}

/** Order-sensitive equality on two skill lists. ID order is wire-stable so
 *  this is enough — we don't need a set comparison. */
function sameSkillList(a: MapInteractableSkill[], b: MapInteractableSkill[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i].skillId !== b[i].skillId || a[i].skillInstanceUid !== b[i].skillInstanceUid) return false;
    }
    return true;
}

/** Variant tag for entities visible on the current map.
 *  - player        → real human player (incl. ourselves); has name + level.
 *  - monsterGroup  → roving aggressive mob group; has a list of monsters.
 *  - npc           → static dialog/quest NPC; has an npcId for catalog lookup.
 *  - unknown       → discriminator (kgl.epsb) didn't match a known value. */
export type MapEntityKind = "player" | "monsterGroup" | "npc" | "unknown";

export interface MapEntityMonster {
    monsterId: number;
    level: number;
    grade: number;
}

export interface MapEntitySnapshot {
    entityId: string;
    cellId: number | null;
    kind: MapEntityKind;
    name: string | null;
    level: number | null;
    /** Populated when kind === "monsterGroup" — leader + members in one list. */
    monsters?: MapEntityMonster[];
    /** Populated when kind === "npc" — NPC catalog id (resolution offline TBD). */
    npcId?: number;
}

export interface MapInteractableSkill {
    skillId: number;
    skillInstanceUid: number;
}

/** Server-visible interactable on the current map — covers everything the
 *  player can act on, not just harvestables: resource nodes, zaaps, doors,
 *  NPCs, trash cans, houses, percepteur stones, etc. Built by joining
 *  `itx.statedElements` (filtered to `onCurrentMap = true`) with
 *  `itx.interactives` by elementId.
 *
 *  Two orthogonal booleans encode whether the bot can act on it right now:
 *    - `isReady`     — server-side: state === 0 (off cooldown / mature).
 *                      Non-cooldown elements like zaaps stay at 0.
 *    - `canInteract` — player-side: we have at least one enabled skill
 *                      (right job + level for a resource, "open" for a
 *                      door, "enter" for a house, etc.).
 *  A bot can act when BOTH are true. They genuinely diverge — e.g. a
 *  mature bamboo on a paysan-only map shows `isReady && !canInteract`. */
export interface MapInteractable {
    elementId: number;
    cellId: number | null;
    interactiveTypeId: number;
    /** Cooldown state on the wire. 0 = available, ≥1 = ticks until refresh.
     *  Non-cooldown interactables (zaap, door, NPC dialogue) keep this at 0. */
    state: number;
    enabledSkills:  MapInteractableSkill[];
    disabledSkills: MapInteractableSkill[];
    /** Derived: `state === 0`. Element is off cooldown / available. */
    isReady: boolean;
    /** Derived: `enabledSkills.length > 0`. Player has at least one action
     *  the game lets them perform on this element right now. Disabled skills
     *  are surfaced separately so the bot can detect "we'd be able to act
     *  if X" (missing job level, missing key, missing alignment, etc.). */
    canInteract: boolean;
}

export interface MapState {
    mapId: number | null;
    entities: MapEntitySnapshot[];
    interactables: MapInteractable[];
}

/** `kind` discriminates a wholesale snapshot replacement (itx) from a partial
 *  patch (ieu/iet/itv/irx/jvn). Snapshot consumers (PlayerStore re-syncing
 *  currentCellId from the new entity list) only fire on "snapshot" — patches
 *  carry an updated entities array but the local player's authoritative
 *  position is tracked by PlayerStore via itv/itr, never re-derived here. */
export type MapStateChangeKind = "snapshot" | "patch";

type Listener = (state: MapState, kind: MapStateChangeKind) => void;

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
        // Counts as "patch" — we haven't received the new entity list yet,
        // so the local player's cell shouldn't be re-derived from a stale
        // entities[] (it's whatever the last itx had, or empty on first boot).
        if (mapId !== null && this.state.mapId !== mapId) {
            this.state = { ...this.state, mapId };
            this.emit("patch");
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
            characterAttributes_kind:           f.CharacterAttributes_kind,
            characterCard_name:                 f.CharacterCard_name,
            characterCard_progression:          f.CharacterCard_progression,
            progression_levelInfo:              f.CharacterProgression_levelInfo,
            levelInfo_level:                    f.LevelInfo_level,
            monsterGroupCard_content:           f.MonsterGroupCard_content,
            monsterGroupContent_leader:         f.MonsterGroupContent_leader,
            monsterGroupContent_members:        f.MonsterGroupContent_members,
            monsterEntry_monsterId:             f.MonsterEntry_monsterId,
            monsterEntry_level:                 f.MonsterEntry_level,
            monsterEntry_grade:                 f.MonsterEntry_grade,
            npcCard_npcId:                      f.NpcCard_npcId,
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
            // Entity-list patch frames.
            newPlayerOnMapClassName:            c.NewPlayerOnMap,
            playerLeaveMapClassName:            c.PlayerLeaveMap,
            entityMovementClassName:            c.MapEntityMovement,
            newPlayerOnMap_entities:            f.NewPlayerOnMap_entities,
            playerLeaveMap_entityId:            f.PlayerLeaveMap_entityId,
            entityMovement_entityId:            f.MapEntityMovement_entityId,
            entityMovement_cellPath:            f.MapEntityMovement_cellPath,
        };
    }

    private handleFrame(frame: NetworkFrame): void {
        const cn = frame.typeKey.className;
        const cls = this.resolvedProto.classes;
        if (cn === cls.StatedElementUpdate)        { this.handleStatedElementUpdate(frame); return; }
        if (cn === cls.InteractiveElementUpdated)  { this.handleInteractiveElementUpdate(frame); return; }
        if (cn === cls.NewPlayerOnMap)             { this.handleNewPlayerOnMap(frame); return; }
        if (cn === cls.PlayerLeaveMap)             { this.handlePlayerLeaveMap(frame); return; }
        if (cn === cls.MapEntityMovement)          { this.handleEntityMovement(frame); return; }
        if (cn !== cls.MapInfo) return;
        const parsed = parseItx(frame, this.currentItxObfNames());
        if (!parsed) return;

        const entities: MapEntitySnapshot[] = parsed.entities.map((e) => ({
            entityId: e.entityId,
            cellId: e.cellId,
            kind: e.kind,
            name: e.name,
            level: e.level,
            ...(e.monsters ? { monsters: e.monsters } : {}),
            ...(e.npcId !== undefined ? { npcId: e.npcId } : {}),
        }));

        // Interactables = (statedElements where onCurrentMap=true) ⨝ interactives
        // on elementId. The stated entry brings the live cellId + cooldown state;
        // the interactives entry brings the skill lists. Static map decor that
        // has an interactive entry but no stated entry (NPCs, zaaps, doors, etc.)
        // is also surfaced — the absence of a stated record just means there's
        // no cooldown to track.
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
                canInteract: enabledSkills.length > 0,
            });
        }

        const next: MapState = { mapId: parsed.mapId, entities, interactables };
        if (!this.diff(this.state, next)) return;
        this.state = next;
        this.emit("snapshot");
    }

    /** ieu (StatedElementUpdate) — server pushes a single kdb payload to
     *  refresh state / cell of one interactable. NOTE: `onCurrentMap` flips
     *  to false during the post-harvest cooldown but the element doesn't
     *  actually leave the map — we keep it in the list with isReady=false
     *  so the bot still sees "there's a resource at cell X, currently in
     *  cooldown". The flag is only meaningful as a "ghost from a neighbour
     *  map" signal in the initial itx broadcast. */
    private handleStatedElementUpdate(frame: NetworkFrame): void {
        const se = parseStateUpdate(frame, this.currentItxObfNames());
        if (!se) return;
        const idx = this.state.interactables.findIndex((it) => it.elementId === se.elementId);
        if (idx < 0) return;  // unknown element — wait for the next itx to seed it

        const prev = this.state.interactables[idx];
        const isReady = se.state === 0;
        if (prev.state === se.state && prev.cellId === se.cell && prev.isReady === isReady) return;
        const patched: MapInteractable = { ...prev, state: se.state, cellId: se.cell, isReady };
        const next = this.state.interactables.slice();
        next[idx] = patched;
        this.state = { ...this.state, interactables: next };
        this.emit("patch");
    }

    /** iet (InteractiveElementUpdated) — server pushes a single kne payload
     *  with the skills currently enabled/disabled on this element. The
     *  update is partial: fields the server didn't touch (typeId, sometimes
     *  disabledSkills) are absent from the wire and we preserve the old
     *  value. Skill lists are replaced wholesale by what the frame carries. */
    private handleInteractiveElementUpdate(frame: NetworkFrame): void {
        const f = this.resolvedProto.fields;
        const payload = findField(frame.fields, f.InteractiveElementUpdated_payload);
        if (!payload?.children) return;

        const elementId = intFromField(findField(payload.children, f.InteractiveElement_elementId));
        if (elementId === null) return;
        const idx = this.state.interactables.findIndex((it) => it.elementId === elementId);
        if (idx < 0) return;  // unknown — wait for the next itx

        const prev = this.state.interactables[idx];
        const enabledField  = findField(payload.children, f.InteractiveElement_enabledSkills);
        const disabledField = findField(payload.children, f.InteractiveElement_disabledSkills);
        const enabledSkills  = enabledField
            ? readSkillsFromList(enabledField, f.InteractiveElementSkill_skillId, f.InteractiveElementSkill_skillInstanceUid)
            : prev.enabledSkills;
        const disabledSkills = disabledField
            ? readSkillsFromList(disabledField, f.InteractiveElementSkill_skillId, f.InteractiveElementSkill_skillInstanceUid)
            : prev.disabledSkills;

        const canInteract = enabledSkills.length > 0;
        const sameEnabled  = sameSkillList(prev.enabledSkills,  enabledSkills);
        const sameDisabled = sameSkillList(prev.disabledSkills, disabledSkills);
        if (sameEnabled && sameDisabled && prev.canInteract === canInteract) return;

        const patched: MapInteractable = { ...prev, enabledSkills, disabledSkills, canInteract };
        const next = this.state.interactables.slice();
        next[idx] = patched;
        this.state = { ...this.state, interactables: next };
        this.emit("patch");
    }

    /** irx (newPlayerOnMap) — adds the new entities to the live list.
     *  Duplicate entityIds (e.g. a re-broadcast after a quick zone wobble)
     *  replace the existing entry. */
    private handleNewPlayerOnMap(frame: NetworkFrame): void {
        const parsed = parseNewPlayerOnMap(frame, this.currentItxObfNames());
        if (!parsed || parsed.length === 0) return;
        const next = this.state.entities.slice();
        let changed = false;
        for (const e of parsed) {
            const entry: MapEntitySnapshot = {
                entityId: e.entityId,
                cellId: e.cellId,
                kind: e.kind,
                name: e.name,
                level: e.level,
                ...(e.monsters ? { monsters: e.monsters } : {}),
                ...(e.npcId !== undefined ? { npcId: e.npcId } : {}),
            };
            const idx = next.findIndex((x) => x.entityId === e.entityId);
            if (idx >= 0) {
                const prev = next[idx];
                if (prev.cellId !== entry.cellId || prev.name !== entry.name || prev.level !== entry.level || prev.kind !== entry.kind) {
                    next[idx] = entry;
                    changed = true;
                }
            } else {
                next.push(entry);
                changed = true;
            }
        }
        if (!changed) return;
        this.state = { ...this.state, entities: next };
        this.emit("patch");
    }

    /** jvn (playerLeaveMap) — drops the entity from the live list. */
    private handlePlayerLeaveMap(frame: NetworkFrame): void {
        const parsed = parsePlayerLeaveMap(frame, this.currentItxObfNames());
        if (!parsed) return;
        const idx = this.state.entities.findIndex((e) => e.entityId === parsed.entityId);
        if (idx < 0) return;
        const next = this.state.entities.slice();
        next.splice(idx, 1);
        this.state = { ...this.state, entities: next };
        this.emit("patch");
    }

    /** itv (mapEntityMovement) — updates the moving entity's cellId to the
     *  last cell of the path (the destination). For the local player our
     *  PlayerStore has its own itv handler running in parallel for
     *  currentCellId; this one is for everyone else's positional tracking
     *  on the minimap. Self-entries getting overwritten here is harmless
     *  because routes/index.ts gates handleMapEntities to kind="snapshot". */
    private handleEntityMovement(frame: NetworkFrame): void {
        const parsed = parseEntityMovement(frame, this.currentItxObfNames());
        if (!parsed) return;
        const idx = this.state.entities.findIndex((e) => e.entityId === parsed.entityId);
        if (idx < 0) return;  // entity not known yet — wait for irx or next itx
        const dest = parsed.cellPath[parsed.cellPath.length - 1];
        if (this.state.entities[idx].cellId === dest) return;
        const next = this.state.entities.slice();
        next[idx] = { ...next[idx], cellId: dest };
        this.state = { ...this.state, entities: next };
        this.emit("patch");
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
            if (ia.canInteract !== ib.canInteract) return true;
            if (ia.enabledSkills.length !== ib.enabledSkills.length) return true;
            if (ia.disabledSkills.length !== ib.disabledSkills.length) return true;
        }
        return false;
    }

    private emit(kind: MapStateChangeKind): void {
        const snap = this.getState();
        for (const l of this.listeners) {
            try { l(snap, kind); } catch (e) { console.warn("[map-state] listener threw:", e); }
        }
    }
}
