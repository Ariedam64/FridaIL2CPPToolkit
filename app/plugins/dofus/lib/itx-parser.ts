// Pure parser for the itx (MapComplementaryInformationsDataMessage) frame.
// Extracts the bits we care about for both action resolution (skillInstanceUid)
// and offline cross-ref with static map data (typeId per interactive).
//
// The frame's class name and field names are obfuscated and may shift between
// game builds — this parser pulls everything by obfuscated name through a
// small option object so the caller can override after a rename. Defaults
// match the build observed during the live capture session.

import type { NetworkFrame, FrameField } from "../../../backend/core/network/types";
import { findField, intFromField, boolFromField } from "./frame-await";

export interface ItxObfNames {
    /** Top-level class name of the itx frame ("itx" by default). */
    className: string;
    /** Class name of the StatedElementUpdate frame ("ieu" by default). */
    stateUpdateClassName: string;
    /** Class name of the InteractiveElementUpdate frame ("iet" by default). */
    elementUpdateClassName: string;
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
    entity_position: string;              // epxa (nested kjp)
    position_cellId: string;              // eqqq (int)
}

export const DEFAULT_ITX_OBF: ItxObfNames = {
    className: "itx",
    stateUpdateClassName: "ieu",
    elementUpdateClassName: "iet",
    mapId: "efti",
    interactivesArray: "eftt",
    statedElementsArray: "eftq",
    stateUpdatePayload: "econ",
    elementUpdatePayload: "ecoj",
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
};

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

/** One entity present on the map at the moment the itx was broadcast.
 *  `entityId` is the server-side stable id (matches `LocalCharacter.characterId`
 *  for the local player). Kept as string to dodge JS-side int53 surprises. */
export interface ParsedEntity {
    entityId: string;
    cellId: number;
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
            const idField = findField(khg.children, obf.entity_entityId);
            // entityId is Int64 → preview may be the stringified number;
            // intFromField copes with both number-typed and string-typed fields.
            const entityId = idField?.preview;
            if (!entityId) continue;
            const pos = findField(khg.children, obf.entity_position);
            const cellId = pos?.children ? intFromField(findField(pos.children, obf.position_cellId)) : null;
            if (cellId === null) continue;
            entities.push({ entityId, cellId });
        }
    }

    return { mapId, capturedAt: frame.timestamp, interactives, statedElements, entities };
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
