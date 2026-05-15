// Pure parser for the itx (MapComplementaryInformationsDataMessage) frame.
// Extracts the bits we care about for both action resolution (skillInstanceUid)
// and offline cross-ref with static map data (typeId per interactive).
//
// The frame's class name and field names are obfuscated and may shift between
// game builds — this parser pulls everything by obfuscated name through a
// small option object so the caller can override after a rename. Defaults
// match the build observed during the live capture session.

import type { NetworkFrame, FrameField } from "../../../../backend/core/network/types";
import { findField, intFromField, boolFromField } from "../frame-await";

export interface ItxObfNames {
    /** Top-level class name of the itx frame ("itx" by default). */
    className: string;
    /** Class name of the StatedElementUpdate frame ("ieu" by default). */
    stateUpdateClassName: string;
    /** Class name of the InteractiveElementUpdate frame ("iet" by default). */
    elementUpdateClassName: string;
    /** Class name of the NewPlayerOnMap frame ("irx" by default) — fires when
     *  a player joins the current map. Carries a single-entity efig array. */
    newPlayerOnMapClassName: string;
    /** Class name of the PlayerLeaveMap frame ("jvn" by default) — fires when
     *  an entity leaves the current map. */
    playerLeaveMapClassName: string;
    /** Class name of the MapEntityMovement frame ("itv" by default) — fires
     *  for every entity move on the map (including our own — filter by
     *  entityId === characterId for self vs others). */
    entityMovementClassName: string;
    /** Long mapId field on the frame. */
    mapId: string;
    /** RepeatedField<kne> field listing the interactives. */
    interactivesArray: string;
    /** RepeatedField<kdb> field listing the dynamic state of harvestables. */
    statedElementsArray: string;
    /** Field on `ieu` carrying the nested kdb payload. */
    stateUpdatePayload: string;
    /** Field on `iet` carrying the nested kne payload. */
    elementUpdatePayload: string;
    /** Field on `irx` carrying the RepeatedField<khg> of new entities. */
    newPlayerOnMap_entities: string;
    /** Field on `jvn` carrying the entityId of the leaver. */
    playerLeaveMap_entityId: string;
    /** Field on `itv` carrying the entityId of the mover. */
    entityMovement_entityId: string;
    /** Field on `itv` carrying the RepeatedField<int> cellPath. */
    entityMovement_cellPath: string;
    // kne (one entry per interactive)
    interactiveTypeId: string;          // erqx
    interactiveElementId: string;       // erqk
    interactiveSkillsActive: string;    // erqn
    interactiveSkillsDisabled: string;  // erqv
    // knc (one entry per skill on an interactive)
    skillId: string;                    // erpy
    skillInstanceUid: string;           // erqd
    // kdb (one entry per stated/harvestable element)
    statedElement_state: string;          // eoun: 0=available, ≥1=cooldown
    statedElement_onCurrentMap: string;   // eoup: true=really on this map, false=ghost from neighbour
    statedElement_elementId: string;      // eour
    statedElement_cell: string;           // eout
    // Entities array (eftd) — server broadcasts every entity on the map after
    // a map change. The local player's entry carries its arrival cellId,
    // which `dve.dezz` doesn't pick up (it only updates on click).
    entitiesArray: string;                // eftd
    entity_entityId: string;              // epww (long)
    entity_position: string;              // epxa (nested EntityPosition / kjp)
    position_cellId: string;              // eqqq (int)
    // Deep chain into the per-entity character data — name + level for
    // player-class entities. NPCs/monsters lack these so every level of the
    // walk is null-tolerant.
    entity_look: string;                  // epxc → EntityLook (khe)
    look_characterAttributes: string;     // epwr → CharacterAttributes (kgl)
    characterAttributes_characterCard: string;  // epsa → CharacterCard (polymorphic: kgb player / kgg monsterGroup / kgj npc)
    /** Enum on `kgl` discriminating the variant of `characterCard` (epsa).
     *  Observed values: 7 = player, 3 = monsterGroup, 5 = npc. */
    characterAttributes_kind: string;     // epsb (enum)
    characterCard_name: string;           // eppb (player only, on kgb)
    characterCard_progression: string;    // eppe → CharacterProgression (kfy)
    progression_levelInfo: string;        // epor → LevelInfo (kli)
    levelInfo_level: string;              // ereh (int)
    // MonsterGroupCard (kgg) — when CharacterAttributes_kind === 3
    monsterGroupCard_content: string;     // epqm → MonsterGroupContent (kcj)
    monsterGroupContent_leader: string;   // eood → MonsterEntry (kjs)
    monsterGroupContent_members: string;  // eoob → RepeatedField<kjs>
    monsterEntry_monsterId: string;       // eqrp (int = monsters catalog id)
    monsterEntry_level: string;           // eqrt (int)
    monsterEntry_grade: string;           // eqrn (int, grade 1..5)
    // NpcCard (kgj) — when CharacterAttributes_kind === 5
    npcCard_npcId: string;                // epro (int = NpcsDataRoot id)
}

export const DEFAULT_ITX_OBF: ItxObfNames = {
    className: "itx",
    stateUpdateClassName: "ieu",
    elementUpdateClassName: "iet",
    newPlayerOnMapClassName: "irx",
    playerLeaveMapClassName: "jvn",
    entityMovementClassName: "itv",
    mapId: "efti",
    interactivesArray: "eftt",
    statedElementsArray: "eftq",
    stateUpdatePayload: "econ",
    elementUpdatePayload: "ecoj",
    newPlayerOnMap_entities: "efig",
    playerLeaveMap_entityId: "elbt",
    entityMovement_entityId: "efss",
    entityMovement_cellPath: "efsq",
    interactiveTypeId: "erqx",
    interactiveElementId: "erqk",
    interactiveSkillsActive: "erqn",
    interactiveSkillsDisabled: "erqv",
    skillId: "erpy",
    skillInstanceUid: "erqd",
    statedElement_state: "eoun",
    statedElement_onCurrentMap: "eoup",
    statedElement_elementId: "eour",
    statedElement_cell: "eout",
    entitiesArray: "eftd",
    entity_entityId: "epww",
    entity_position: "epxa",
    position_cellId: "eqqq",
    entity_look: "epxc",
    look_characterAttributes: "epwr",
    characterAttributes_characterCard: "epsa",
    characterAttributes_kind: "epsb",
    characterCard_name: "eppb",
    characterCard_progression: "eppe",
    progression_levelInfo: "epor",
    levelInfo_level: "ereh",
    monsterGroupCard_content: "epqm",
    monsterGroupContent_leader: "eood",
    monsterGroupContent_members: "eoob",
    monsterEntry_monsterId: "eqrp",
    monsterEntry_level: "eqrt",
    monsterEntry_grade: "eqrn",
    npcCard_npcId: "epro",
};

/** CharacterAttributes_kind enum values — discriminate the variant of the
 *  nested `characterCard` field. */
export const ENTITY_KIND_PLAYER = 7;
export const ENTITY_KIND_MONSTER_GROUP = 3;
export const ENTITY_KIND_NPC = 5;

export interface ParsedSkill {
    skillId: number;
    skillInstanceUid: number;
    /** True if it was in the active list, false if it was in the disabled list. */
    active: boolean;
}

export interface ParsedInteractive {
    elementId: number;
    typeId: number;
    skills: ParsedSkill[];
}

/** Dynamic state of a harvestable element on the map (StatedElement / kdb).
 *  - state: 0 = available, ≥1 = cooldown / just harvested
 *  - onCurrentMap: true = really on this map, false = ghost visible from a neighbour */
export interface ParsedStatedElement {
    elementId: number;
    cell: number;
    state: number;
    onCurrentMap: boolean;
}

/** Variant tag for entities on the map — discriminated by
 *  `CharacterAttributes.kind` (kgl.epsb). */
export type EntityKind = "player" | "monsterGroup" | "npc" | "unknown";

/** One monster in a group's leader/members lists. */
export interface ParsedMonster {
    monsterId: number;   // → catalog/monsters.json id
    level: number;
    grade: number;       // 1..5, the rank within the group
}

/** One entity present on the map at the moment the itx was broadcast.
 *  `entityId` is the server-side stable id for players, a synthetic
 *  negative id for monster groups / NPCs (shared pseudo-id namespace).
 *  Kept as string to dodge JS-side int53 surprises.
 *
 *  Variant fields are populated based on `kind`:
 *   - player        → name, level
 *   - monsterGroup  → monsters[] (leader + members combined)
 *   - npc           → npcId
 *   - unknown       → none */
export interface ParsedEntity {
    entityId: string;
    cellId: number;
    kind: EntityKind;
    name: string | null;
    level: number | null;
    monsters?: ParsedMonster[];
    npcId?: number;
}

export interface ParsedItx {
    mapId: number;
    capturedAt: number;
    interactives: ParsedInteractive[];
    statedElements: ParsedStatedElement[];
    entities: ParsedEntity[];
}

/** Returns null if the frame isn't a valid itx (wrong class or missing fields). */
export function parseItx(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedItx | null {
    if (frame.typeKey.className !== obf.className) return null;
    const mapId = intFromField(findField(frame.fields, obf.mapId));
    if (mapId === null) return null;

    const arr = findField(frame.fields, obf.interactivesArray);
    const interactives: ParsedInteractive[] = [];
    if (arr?.children) {
        for (const kne of arr.children) {
            if (kne.name === "…" || !kne.children) continue;
            const elementId = intFromField(findField(kne.children, obf.interactiveElementId));
            const typeId = intFromField(findField(kne.children, obf.interactiveTypeId));
            if (elementId === null || typeId === null) continue;
            const skills = [
                ...readSkills(findField(kne.children, obf.interactiveSkillsActive), true, obf),
                ...readSkills(findField(kne.children, obf.interactiveSkillsDisabled), false, obf),
            ];
            interactives.push({ elementId, typeId, skills });
        }
    }

    const statedElements: ParsedStatedElement[] = [];
    const seArr = findField(frame.fields, obf.statedElementsArray);
    if (seArr?.children) {
        for (const kdb of seArr.children) {
            if (kdb.name === "…" || !kdb.children) continue;
            const elementId = intFromField(findField(kdb.children, obf.statedElement_elementId));
            const cell = intFromField(findField(kdb.children, obf.statedElement_cell));
            if (elementId === null || cell === null) continue;
            statedElements.push({
                elementId, cell,
                state: intFromField(findField(kdb.children, obf.statedElement_state)) ?? 0,
                onCurrentMap: boolFromField(findField(kdb.children, obf.statedElement_onCurrentMap)) ?? false,
            });
        }
    }

    const entities: ParsedEntity[] = [];
    const entArr = findField(frame.fields, obf.entitiesArray);
    if (entArr?.children) {
        for (const khg of entArr.children) {
            if (khg.name === "…" || !khg.children) continue;
            const e = parseEntity(khg, obf);
            if (e) entities.push(e);
        }
    }

    return { mapId, capturedAt: frame.timestamp, interactives, statedElements, entities };
}

/** Parse a single `khg` entry into a ParsedEntity. Returns null if entityId
 *  or cellId are missing — these are the only fields all variants must
 *  carry. Per-kind data is best-effort and absent if the discriminator or
 *  inner shape doesn't match.
 *
 *  Discriminator: `CharacterAttributes.kind` (kgl.epsb) — an enum value
 *  picked from the ENTITY_KIND_* constants. */
export function parseEntity(khg: FrameField, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedEntity | null {
    if (!khg.children) return null;
    const idField = findField(khg.children, obf.entity_entityId);
    const entityId = idField?.preview;
    if (!entityId) return null;
    const pos = findField(khg.children, obf.entity_position);
    const cellId = pos?.children ? intFromField(findField(pos.children, obf.position_cellId)) : null;
    if (cellId === null) return null;

    const look = findField(khg.children, obf.entity_look);
    const charAttrs = look?.children ? findField(look.children, obf.look_characterAttributes) : undefined;

    // Discriminator first — drives which variant fields we pull from epsa.
    let kind: EntityKind = "unknown";
    if (charAttrs?.children) {
        const kindField = findField(charAttrs.children, obf.characterAttributes_kind);
        const k = intFromField(kindField);
        if (k === ENTITY_KIND_PLAYER)              kind = "player";
        else if (k === ENTITY_KIND_MONSTER_GROUP)  kind = "monsterGroup";
        else if (k === ENTITY_KIND_NPC)            kind = "npc";
    }

    let name: string | null = null;
    let level: number | null = null;
    let monsters: ParsedMonster[] | undefined;
    let npcId: number | undefined;

    const charCard = charAttrs?.children
        ? findField(charAttrs.children, obf.characterAttributes_characterCard)
        : undefined;

    if (charCard?.children) {
        if (kind === "player") {
            const nameField = findField(charCard.children, obf.characterCard_name);
            if (nameField && nameField.preview && nameField.preview !== "null") {
                name = nameField.preview.replace(/^"|"$/g, "");
            }
            const progression = findField(charCard.children, obf.characterCard_progression);
            const levelInfo = progression?.children ? findField(progression.children, obf.progression_levelInfo) : undefined;
            if (levelInfo?.children) {
                level = intFromField(findField(levelInfo.children, obf.levelInfo_level));
            }
        } else if (kind === "monsterGroup") {
            monsters = [];
            const content = findField(charCard.children, obf.monsterGroupCard_content);
            if (content?.children) {
                const pushEntry = (entry: FrameField): void => {
                    if (!entry.children) return;
                    const mid = intFromField(findField(entry.children, obf.monsterEntry_monsterId));
                    const lvl = intFromField(findField(entry.children, obf.monsterEntry_level));
                    const grade = intFromField(findField(entry.children, obf.monsterEntry_grade));
                    if (mid === null || lvl === null) return;
                    monsters!.push({ monsterId: mid, level: lvl, grade: grade ?? 0 });
                };
                const leader = findField(content.children, obf.monsterGroupContent_leader);
                if (leader) pushEntry(leader);
                const members = findField(content.children, obf.monsterGroupContent_members);
                if (members?.children) {
                    for (const kjs of members.children) {
                        if (kjs.name === "…") continue;
                        pushEntry(kjs);
                    }
                }
            }
        } else if (kind === "npc") {
            const idVal = intFromField(findField(charCard.children, obf.npcCard_npcId));
            if (idVal !== null) npcId = idVal;
        }
    }

    return { entityId, cellId, kind, name, level, ...(monsters ? { monsters } : {}), ...(npcId !== undefined ? { npcId } : {}) };
}

/** Parse `irx` (newPlayerOnMap) — same khg shape as itx.eftd, wrapped in a
 *  different array field (efig). Returns the parsed entities (typically 1). */
export function parseNewPlayerOnMap(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedEntity[] | null {
    if (frame.typeKey.className !== obf.newPlayerOnMapClassName) return null;
    const arr = findField(frame.fields, obf.newPlayerOnMap_entities);
    if (!arr?.children) return [];
    const out: ParsedEntity[] = [];
    for (const khg of arr.children) {
        if (khg.name === "…" || !khg.children) continue;
        const e = parseEntity(khg, obf);
        if (e) out.push(e);
    }
    return out;
}

/** Parse `jvn` (playerLeaveMap) — just an entityId (Int64). */
export function parsePlayerLeaveMap(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): { entityId: string } | null {
    if (frame.typeKey.className !== obf.playerLeaveMapClassName) return null;
    const idField = findField(frame.fields, obf.playerLeaveMap_entityId);
    const entityId = idField?.preview;
    if (!entityId) return null;
    return { entityId };
}

/** Parse `itv` (mapEntityMovement) — entityId + cellPath. The cellPath's
 *  last element is the destination cell. */
export function parseEntityMovement(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): { entityId: string; cellPath: number[] } | null {
    if (frame.typeKey.className !== obf.entityMovementClassName) return null;
    const idField = findField(frame.fields, obf.entityMovement_entityId);
    const entityId = idField?.preview;
    if (!entityId) return null;
    const pathField = findField(frame.fields, obf.entityMovement_cellPath);
    if (!pathField?.children) return null;
    const cellPath: number[] = [];
    for (const c of pathField.children) {
        const n = intFromField(c);
        if (n !== null) cellPath.push(n);
    }
    if (cellPath.length === 0) return null;
    return { entityId, cellPath };
}

/** Parse a single kne FrameField (the nested representation, not its parent
 *  RepeatedField). Returns null if essential fields are missing. */
export function parseKne(kne: FrameField, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedInteractive | null {
    if (!kne.children) return null;
    const elementId = intFromField(findField(kne.children, obf.interactiveElementId));
    const typeId = intFromField(findField(kne.children, obf.interactiveTypeId));
    if (elementId === null || typeId === null) return null;
    return {
        elementId, typeId,
        skills: [
            ...readSkills(findField(kne.children, obf.interactiveSkillsActive), true, obf),
            ...readSkills(findField(kne.children, obf.interactiveSkillsDisabled), false, obf),
        ],
    };
}

/** Parse a single kdb FrameField (StatedElement). */
export function parseKdb(kdb: FrameField, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedStatedElement | null {
    if (!kdb.children) return null;
    const elementId = intFromField(findField(kdb.children, obf.statedElement_elementId));
    const cell = intFromField(findField(kdb.children, obf.statedElement_cell));
    if (elementId === null || cell === null) return null;
    return {
        elementId, cell,
        state: intFromField(findField(kdb.children, obf.statedElement_state)) ?? 0,
        onCurrentMap: boolFromField(findField(kdb.children, obf.statedElement_onCurrentMap)) ?? false,
    };
}

/** Parse a `ieu` (StatedElementUpdate) frame — single kdb payload. */
export function parseStateUpdate(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedStatedElement | null {
    if (frame.typeKey.className !== obf.stateUpdateClassName) return null;
    const payload = findField(frame.fields, obf.stateUpdatePayload);
    return payload ? parseKdb(payload, obf) : null;
}

/** Parse a `iet` (InteractiveElementUpdate) frame — single kne payload. */
export function parseElementUpdate(frame: NetworkFrame, obf: ItxObfNames = DEFAULT_ITX_OBF): ParsedInteractive | null {
    if (frame.typeKey.className !== obf.elementUpdateClassName) return null;
    const payload = findField(frame.fields, obf.elementUpdatePayload);
    return payload ? parseKne(payload, obf) : null;
}

function readSkills(arr: FrameField | undefined, active: boolean, obf: ItxObfNames): ParsedSkill[] {
    if (!arr?.children) return [];
    const out: ParsedSkill[] = [];
    for (const knc of arr.children) {
        if (knc.name === "…" || !knc.children) continue;
        const skillId = intFromField(findField(knc.children, obf.skillId));
        const skillInstanceUid = intFromField(findField(knc.children, obf.skillInstanceUid));
        if (skillId === null || skillInstanceUid === null) continue;
        out.push({ skillId, skillInstanceUid, active });
    }
    return out;
}
