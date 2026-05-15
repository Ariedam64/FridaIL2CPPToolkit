// Map interactives runtime store — single source of truth for the Dofus
// plugin's runtime view of the world.
//
// Subscribes to the network monitor's FrameStore, parses every itx/iet/ieu and
// keeps:
//   - Per-map IDENTIFICATION data persisted to `.toolkit-data/maps-runtime.json`
//     — slim shape: { elementId, typeId, gfxId, cell, skillIds }. NO live
//     state on disk (no harvestState / no skillInstanceUid / no active flag).
//     The persisted DB is a name-resolution catalog for offline display.
//   - In-RAM live state additionally carries skillInstanceUids and active
//     flags + harvestState on the RuntimeSkill/RuntimeInteractive — these
//     are refreshed from each itx/iet/ieu during a session and used by the
//     "use interactive" action. They're dropped on flush — the next session
//     starts with placeholders that get refilled on the first itx.
//   - The CANONICAL static DB (`app/plugins/dofus/data/static-db.json`). Each
//     time we learn a new (typeId → gfxId) or (typeId → skillId) link via
//     joining itx.eftt with the per-map static `ie`, we auto-enrich the DB.
//
// All friendly names (typeName / skillName / item name) are looked up on
// demand from the static DB — never duplicated in the runtime store. The
// caller hydrates the API response.

import * as fs from "node:fs";
import * as path from "node:path";
import type { FrameStore } from "../../../../backend/core/network/frame-store";
import type { NetworkFrame } from "../../../../backend/core/network/types";
import type { LabelStore } from "../../../../backend/core/labels";
import { parseItx, parseStateUpdate, parseElementUpdate, DEFAULT_ITX_OBF, type ItxObfNames, type ParsedInteractive, type ParsedStatedElement } from "../protocol/itx-parser";
import type { DofusDataStore } from "./data";
import { MAP_INFO_PROTO, type ResolvedMapInfoProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";

function resolveItxObfNames(labels: LabelStore): ItxObfNames {
    const r = resolveProto(labels, MAP_INFO_PROTO) as ResolvedMapInfoProto;
    // Spread DEFAULT_ITX_OBF first so any fields not in MAP_INFO_PROTO (notably
    // the entities-array path used by PlayerStore) get their hardcoded
    // fallback values without forcing every caller to remember them.
    return {
        ...DEFAULT_ITX_OBF,
        className:                  r.classes.Message,
        stateUpdateClassName:       r.classes.StateUpdate,
        elementUpdateClassName:     r.classes.ElementUpdate,
        mapId:                      r.fields.Message_mapId,
        interactivesArray:          r.fields.Message_interactives,
        statedElementsArray:        r.fields.Message_statedElements,
        stateUpdatePayload:         r.fields.StateUpdate_payload,
        elementUpdatePayload:       r.fields.ElementUpdate_payload,
        interactiveElementId:       r.fields.Interactive_elementId,
        interactiveTypeId:          r.fields.Interactive_interactiveTypeId,
        interactiveSkillsActive:    r.fields.Interactive_enabledSkills,
        interactiveSkillsDisabled:  r.fields.Interactive_disabledSkills,
        skillId:                    r.fields.Skill_skillId,
        skillInstanceUid:           r.fields.Skill_skillInstanceUid,
        statedElement_state:        r.fields.StatedElement_state,
        statedElement_onCurrentMap: r.fields.StatedElement_onCurrentMap,
        statedElement_elementId:    r.fields.StatedElement_elementId,
        statedElement_cell:         r.fields.StatedElement_cell,
    };
}

/** Slim runtime view of an interactive on a map — identification only.
 *  Live state (skillInstanceUid, active flag, harvestState) is NOT tracked
 *  here; for action invocation, callers go through MapStateStore which
 *  mirrors the current itx in RAM. */
export interface RuntimeInteractive {
    elementId: number;
    /** Resolved from static `ie` on the same mapId. null = element not in
     *  the static dump (server-side dynamic spawn — zaaps placed runtime,
     *  player shops, etc.). */
    cell: number | null;
    gfxId: number | null;
    typeId: number;
    skillIds: number[];
}

interface MapEntry {
    mapId: number;
    interactives: RuntimeInteractive[];
    lastSeenAt: number;
}

/** Slim per-interactive shape on disk — identification only, no state. */
interface PersistedInteractive {
    elementId: number;
    typeId: number;
    gfxId: number | null;
    cell: number | null;
    skillIds: number[];
}

interface PersistedMap {
    mapId: number;
    lastSeenAt: number;
    interactives: PersistedInteractive[];
}

interface PersistedShape {
    schemaVersion: 3;
    updatedAt: string;
    maps: Record<string, PersistedMap>;
}

// --- Static DB ---

interface StaticDbInteractive {
    name: string;
    gfxIds?: number[];
    skillIds?: number[];
    mapCount?: number;
}

interface StaticDbSkill {
    name: string;
    jobId: number;
    jobName: string;
    gatheredItem?: { id: number; name: string };
    elementActionId?: number;
    levelMin?: number;
}

interface StaticDb {
    version: number;
    generatedAt?: string;
    interactives: Record<string, StaticDbInteractive>;
    skills: Record<string, StaticDbSkill>;
    items: Record<string, { name: string }>;
    jobs: Record<string, { name: string }>;
}

const FLUSH_DEBOUNCE_MS = 1000;

export interface MapInteractivesStoreDeps {
    /** Path to maps-runtime.json (e.g. .toolkit-data/maps-runtime.json). */
    filePath: string;
    /** Path to the canonical static DB built by `dofus:build-static-db` and
     *  enriched on the fly here. The store mutates this file in place when it
     *  learns a new (typeId → gfxId) or (typeId → skillId) link. */
    staticDbPath: string;
    /** Static map data store, used to cross-ref elementId → cell+gfxId. */
    dataStore: DofusDataStore;
    /** Label store for resolving the obfuscated names of itx and its nested
     *  classes (kne / knc) — re-resolved on every label change. */
    labels: LabelStore;
}

export class MapInteractivesStore {
    private maps = new Map<number, MapEntry>();
    private staticDb: StaticDb;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;
    private staticDbFlushTimer: ReturnType<typeof setTimeout> | null = null;
    private dirty = false;
    private staticDbDirty = false;
    private obfNames: ItxObfNames;
    private labelChangeUnsub: (() => void) | null = null;
    /** mapId of the latest itx — used to apply ieu/iet updates which don't carry one. */
    private currentMapId: number | null = null;
    /** elementIds known to be ghosts (visible from a neighbour map). Cleared on
     *  full itx for a fresh map snapshot. */
    private ghostElementIds = new Set<number>();

    constructor(private readonly deps: MapInteractivesStoreDeps) {
        this.staticDb = this.loadStaticDb();
        this.obfNames = resolveItxObfNames(deps.labels);
        // Re-resolve when any label changes so the parser keeps up with
        // mid-session renames.
        this.labelChangeUnsub = deps.labels.onChange(() => {
            this.obfNames = resolveItxObfNames(deps.labels);
        });
        this.loadFromDisk();
    }

    dispose(): void {
        this.labelChangeUnsub?.();
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        if (this.staticDbFlushTimer) { clearTimeout(this.staticDbFlushTimer); this.staticDbFlushTimer = null; }
    }

    attach(frameStore: FrameStore): () => void {
        const handler = (frame: NetworkFrame) => { void this.onFrame(frame); };
        frameStore.on("frame-added", handler);
        return () => { frameStore.off("frame-added", handler); };
    }

    // --- Public reads ---

    getCurrentMapId(): number | null { return this.currentMapId; }
    getMap(mapId: number): MapEntry | undefined { return this.maps.get(mapId); }

    /** Friendly name for a typeId, via static DB. Falls back to a placeholder
     *  when the typeId isn't catalogued (rare — we have all 428 in the dump). */
    typeName(typeId: number): string {
        return this.staticDb.interactives[String(typeId)]?.name ?? `Interactive #${typeId}`;
    }

    /** Skill catalog entry (name + jobName + gatheredItem if any). */
    skillEntry(skillId: number): StaticDbSkill | undefined {
        return this.staticDb.skills[String(skillId)];
    }

    /** Static DB entry for a typeId. Includes learnt gfxIds + skillIds when
     *  we've ever cross-ref'd them via runtime. */
    staticEntry(typeId: number): StaticDbInteractive | undefined {
        return this.staticDb.interactives[String(typeId)];
    }

    /** Reverse: given a gfxId, find which typeId it belongs to (via the
     *  cumulative gfxIds learnt over time). Returns null if we never saw a
     *  match runtime. */
    typeForGfx(gfxId: number): { typeId: number; typeName: string } | null {
        for (const [tidStr, entry] of Object.entries(this.staticDb.interactives)) {
            if (entry.gfxIds?.includes(gfxId)) {
                return { typeId: Number(tidStr), typeName: entry.name };
            }
        }
        return null;
    }

    /** Snapshot of the static DB suitable for UI display. Returns EVERY type
     *  catalogued in the datacenter dump — name + skills are always known so
     *  the UI can resolve any typeId it sees in itx. `gfxIds` is empty for
     *  types we haven't yet seen runtime, `resolvedTypes` still counts only
     *  those with ≥1 learnt gfxId (= the progress metric). */
    getStaticDbSummary(): {
        totalTypes: number;
        resolvedTypes: number;
        totalGfxLearned: number;
        resolved: Array<{
            typeId: number;
            name: string;
            gfxIds: number[];
            mapCount: number;
            skills: Array<{ skillId: number; name: string; gatheredItem?: { id: number; name: string } }>;
        }>;
    } {
        const interactives = this.staticDb.interactives;
        const totalTypes = Object.keys(interactives).length;
        let resolvedTypes = 0;
        let totalGfxLearned = 0;
        const resolved: ReturnType<MapInteractivesStore["getStaticDbSummary"]>["resolved"] = [];
        for (const [tidStr, e] of Object.entries(interactives)) {
            const gfxIds = e.gfxIds ?? [];
            if (gfxIds.length > 0) {
                resolvedTypes++;
                totalGfxLearned += gfxIds.length;
            }
            const skills = (e.skillIds ?? []).map((sid) => {
                const sk = this.staticDb.skills[String(sid)];
                return {
                    skillId: sid,
                    name: sk?.name ?? `Skill #${sid}`,
                    ...(sk?.gatheredItem ? { gatheredItem: { id: sk.gatheredItem.id, name: sk.gatheredItem.name } } : {}),
                };
            });
            resolved.push({
                typeId: Number(tidStr),
                name: e.name,
                gfxIds: [...gfxIds],
                mapCount: e.mapCount ?? 0,
                skills,
            });
        }
        resolved.sort((a, b) => a.name.localeCompare(b.name));
        return { totalTypes, resolvedTypes, totalGfxLearned, resolved };
    }

    /** Aggregate stats over the runtime store + static DB. Used by the stats
     *  panel of the map page. */
    getStats(): {
        mapCount: number;
        gfxRegistrySize: number;
        interactiveTypeCount: number;
        skills: Array<{ skillId: number; skillName: string; gatheredItem?: { itemId: number; name: string } }>;
        recentMaps: Array<{ mapId: number; lastSeenAt: number; interactivesCount: number }>;
    } {
        const skillsSeen = new Set<number>();
        const recents: Array<{ mapId: number; lastSeenAt: number; interactivesCount: number }> = [];
        let typesSeen = 0;
        let gfxLearnt = 0;
        for (const [mapId, m] of this.maps) {
            recents.push({ mapId, lastSeenAt: m.lastSeenAt, interactivesCount: m.interactives.length });
            for (const i of m.interactives) {
                for (const sid of i.skillIds) skillsSeen.add(sid);
            }
        }
        for (const e of Object.values(this.staticDb.interactives)) {
            if (e.gfxIds && e.gfxIds.length > 0) typesSeen++;
            gfxLearnt += e.gfxIds?.length ?? 0;
        }
        recents.sort((a, b) => b.lastSeenAt - a.lastSeenAt);

        const skills = [...skillsSeen]
            .map((skillId) => {
                const e = this.staticDb.skills[String(skillId)];
                const skillName = e ? (e.gatheredItem ? `${e.name} (${e.gatheredItem.name})` : e.name) : `Skill #${skillId}`;
                const gatheredItem = e?.gatheredItem ? { itemId: e.gatheredItem.id, name: e.gatheredItem.name } : undefined;
                return gatheredItem ? { skillId, skillName, gatheredItem } : { skillId, skillName };
            })
            .sort((a, b) => a.skillName.localeCompare(b.skillName));

        return {
            mapCount: this.maps.size,
            gfxRegistrySize: gfxLearnt,
            interactiveTypeCount: typesSeen,
            skills,
            recentMaps: recents.slice(0, 8),
        };
    }

    // --- Frame ingestion ---

    private async onFrame(frame: NetworkFrame): Promise<void> {
        const obf = this.obfNames;
        if (frame.direction !== "in") return;

        if (frame.typeKey.className === obf.stateUpdateClassName) {
            const se = parseStateUpdate(frame, obf);
            if (se) this.applyStateUpdate(se, frame.timestamp);
            return;
        }
        if (frame.typeKey.className === obf.elementUpdateClassName) {
            const ki = parseElementUpdate(frame, obf);
            if (ki) await this.applyElementUpdate(ki, frame.timestamp);
            return;
        }

        // Full map snapshot.
        if (frame.typeKey.className !== obf.className) return;
        const parsed = parseItx(frame, obf);
        if (!parsed) return;
        this.currentMapId = parsed.mapId;

        // Static `ie` cross-ref by elementId → recover (cell, gfxId).
        const staticIeByElementId = new Map<number, { cell: number; gfxId: number }>();
        try {
            const detail = await this.deps.dataStore.loadMapDetail(parsed.mapId);
            if (detail?.interactives) {
                for (const [cell, elementId, gfxId] of detail.interactives) {
                    staticIeByElementId.set(elementId, { cell, gfxId });
                }
            }
        } catch { /* missing static is fine */ }

        // Reset ghost set for this snapshot. Stated elements with
        // onCurrentMap=false signal "this elementId belongs to a neighbour
        // map" — we drop them from the live list. The eftq cell is also
        // captured as a fallback source of cellId for elements absent from
        // the static `ie` (runtime-only spawns like zaaps).
        this.ghostElementIds.clear();
        const cellFromStatedByElementId = new Map<number, number>();
        for (const se of parsed.statedElements) {
            cellFromStatedByElementId.set(se.elementId, se.cell);
            if (!se.onCurrentMap) this.ghostElementIds.add(se.elementId);
        }

        // Drop ghost interactives entirely. The server announces them for
        // visual continuity (the sprite is rendered at the map edge so the
        // neighbour map "leaks" in) but they're not actionable from here.
        const liveInteractives = parsed.interactives
            .filter((i) => !this.ghostElementIds.has(i.elementId))
            .map((i) => {
                // Cell/gfx resolution priority: static `ie` (has both) →
                // statedElement `cell` (eftq) → null. Runtime-only elements
                // like zaaps never appear in the bundle, but they DO have a
                // kdb in eftq carrying the cell.
                const staticHit = staticIeByElementId.get(i.elementId);
                const cellGfx: { cell: number | null; gfxId: number | null } = staticHit
                    ? { cell: staticHit.cell, gfxId: staticHit.gfxId }
                    : { cell: cellFromStatedByElementId.get(i.elementId) ?? null, gfxId: null };
                return this.buildRuntimeInteractive(i, cellGfx);
            });

        const entry: MapEntry = {
            mapId: parsed.mapId,
            interactives: liveInteractives,
            lastSeenAt: parsed.capturedAt,
        };
        this.maps.set(parsed.mapId, entry);

        // Auto-enrich the static DB with the (typeId → gfxId) and (typeId →
        // skillId) links we just learned.
        for (const i of liveInteractives) this.learnFromInteractive(i, parsed.mapId);

        this.dirty = true;
        this.scheduleFlush();
    }

    /** Apply a `ieu` (StatedElementUpdate). Used for ghost-tracking only —
     *  the slim store doesn't carry harvestState. A ieu with onCurrentMap=false
     *  is the server saying "this elementId belongs to a neighbour map", so
     *  we drop it from our live list. */
    private applyStateUpdate(se: ParsedStatedElement, ts: number): void {
        if (this.currentMapId === null) return;
        if (!se.onCurrentMap) this.ghostElementIds.add(se.elementId);
        else this.ghostElementIds.delete(se.elementId);
        const map = this.maps.get(this.currentMapId);
        if (!map) return;
        if (!se.onCurrentMap) {
            const before = map.interactives.length;
            map.interactives = map.interactives.filter((i) => i.elementId !== se.elementId);
            if (map.interactives.length !== before) {
                map.lastSeenAt = ts;
                this.dirty = true;
                this.scheduleFlush();
            }
        }
    }

    /** Apply a `iet` (ElementUpdate) — adds or replaces a single interactive
     *  on the current map. Skips if elementId is a known ghost. */
    private async applyElementUpdate(i: ParsedInteractive, ts: number): Promise<void> {
        if (this.currentMapId === null) return;
        if (this.ghostElementIds.has(i.elementId)) return;
        const map = this.maps.get(this.currentMapId);
        if (!map) return;
        const idx = map.interactives.findIndex((x) => x.elementId === i.elementId);
        let cellGfx = { cell: null as number | null, gfxId: null as number | null };
        if (idx >= 0) {
            cellGfx = { cell: map.interactives[idx].cell, gfxId: map.interactives[idx].gfxId };
        } else {
            try {
                const detail = await this.deps.dataStore.loadMapDetail(this.currentMapId);
                const triple = detail?.interactives.find(([, eid]) => eid === i.elementId);
                if (triple) cellGfx = { cell: triple[0], gfxId: triple[2] };
            } catch { /* fine */ }
        }
        const fresh = this.buildRuntimeInteractive(i, cellGfx);
        if (idx >= 0) map.interactives[idx] = fresh;
        else map.interactives.push(fresh);
        map.lastSeenAt = ts;

        this.learnFromInteractive(fresh, this.currentMapId);

        this.dirty = true;
        this.scheduleFlush();
    }

    /** Build a slim RuntimeInteractive — no embedded names, no state. Names
     *  are looked up at API hydration time, state lives in MapStateStore. */
    private buildRuntimeInteractive(
        i: ParsedInteractive,
        cellGfx: { cell: number | null; gfxId: number | null },
    ): RuntimeInteractive {
        return {
            elementId: i.elementId,
            cell: cellGfx.cell,
            gfxId: cellGfx.gfxId,
            typeId: i.typeId,
            skillIds: i.skills.map((s) => s.skillId),
        };
    }

    /** Learn (typeId → gfxId) and (typeId → skillId) from a runtime
     *  interactive, merging into the static DB. mapId is recorded for the
     *  popularity counter (used by the stats panel). */
    private learnFromInteractive(i: RuntimeInteractive, mapId: number): void {
        if (i.typeId < 0) return;  // unresolved typeId — nothing to learn
        const key = String(i.typeId);
        const entry = this.staticDb.interactives[key];
        if (!entry) {
            // typeId not in datacenter dump — create a stub so future lookups
            // get something. Names will be `Interactive #<typeId>` until the
            // user re-runs `build-static-db` (which would also pick up this id).
            this.staticDb.interactives[key] = {
                name: `Interactive #${i.typeId}`,
                gfxIds: i.gfxId !== null ? [i.gfxId] : [],
                skillIds: [...i.skillIds],
                mapCount: 1,
            };
            this.staticDbDirty = true;
            this.scheduleStaticDbFlush();
            return;
        }
        let changed = false;
        if (i.gfxId !== null) {
            entry.gfxIds = entry.gfxIds ?? [];
            if (!entry.gfxIds.includes(i.gfxId)) {
                entry.gfxIds.push(i.gfxId);
                entry.gfxIds.sort((a, b) => a - b);
                changed = true;
            }
        }
        for (const sid of i.skillIds) {
            entry.skillIds = entry.skillIds ?? [];
            if (!entry.skillIds.includes(sid)) {
                entry.skillIds.push(sid);
                entry.skillIds.sort((a, b) => a - b);
                changed = true;
            }
        }
        // mapCount is approximated: bump if this is the first time we see the
        // typeId on this mapId. Cheap heuristic — accurate enough for UI.
        // (We only track this in-session — the offline patcher does it
        // properly across all visited maps.)
        // We can't know without per-typeId/per-map tracking; just bump if missing.
        if (entry.mapCount === undefined) {
            entry.mapCount = 1;
            changed = true;
        }
        if (changed) {
            this.staticDbDirty = true;
            this.scheduleStaticDbFlush();
        }
        void mapId;
    }

    // --- Persistence ---

    private scheduleFlush(): void {
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flush().catch((e) => console.warn("[map-interactives] flush failed:", e));
        }, FLUSH_DEBOUNCE_MS);
    }

    private scheduleStaticDbFlush(): void {
        if (this.staticDbFlushTimer) clearTimeout(this.staticDbFlushTimer);
        this.staticDbFlushTimer = setTimeout(() => {
            this.staticDbFlushTimer = null;
            void this.flushStaticDb().catch((e) => console.warn("[map-interactives] static-db flush failed:", e));
        }, FLUSH_DEBOUNCE_MS);
    }

    private async flush(): Promise<void> {
        if (!this.dirty) return;
        this.dirty = false;
        // In-memory shape is already slim — direct mapping to the v3 persisted
        // shape. No live state fields anywhere.
        const data: PersistedShape = {
            schemaVersion: 3,
            updatedAt: new Date().toISOString(),
            maps: Object.fromEntries([...this.maps].map(([k, v]) => {
                const slim: PersistedMap = {
                    mapId: v.mapId,
                    lastSeenAt: v.lastSeenAt,
                    interactives: v.interactives.map((i) => ({
                        elementId: i.elementId,
                        typeId: i.typeId,
                        gfxId: i.gfxId,
                        cell: i.cell,
                        skillIds: [...i.skillIds],
                    })),
                };
                return [String(k), slim];
            })),
        };
        const tmp = this.deps.filePath + ".tmp";
        await fs.promises.mkdir(path.dirname(this.deps.filePath), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
        await fs.promises.rename(tmp, this.deps.filePath);
    }

    private async flushStaticDb(): Promise<void> {
        if (!this.staticDbDirty) return;
        this.staticDbDirty = false;
        const tmp = this.deps.staticDbPath + ".tmp";
        await fs.promises.mkdir(path.dirname(this.deps.staticDbPath), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(this.staticDb, null, 2), "utf-8");
        await fs.promises.rename(tmp, this.deps.staticDbPath);
    }

    // --- Loaders ---

    private loadStaticDb(): StaticDb {
        if (!fs.existsSync(this.deps.staticDbPath)) {
            console.warn(`[map-interactives] static-db not found at ${this.deps.staticDbPath}; starting empty. Run \`npm run dofus:build-static-db\` to bootstrap.`);
            return { version: 1, interactives: {}, skills: {}, items: {}, jobs: {} };
        }
        try {
            return JSON.parse(fs.readFileSync(this.deps.staticDbPath, "utf-8")) as StaticDb;
        } catch (e) {
            console.warn("[map-interactives] static-db parse failed; starting empty:", e);
            return { version: 1, interactives: {}, skills: {}, items: {}, jobs: {} };
        }
    }

    private loadFromDisk(): boolean {
        if (!fs.existsSync(this.deps.filePath)) return false;
        try {
            const raw = fs.readFileSync(this.deps.filePath, "utf-8");
            const data = JSON.parse(raw) as { schemaVersion?: number; maps?: Record<string, unknown> };
            if (data.schemaVersion !== 3) {
                // v1, v2 or unknown — ignored. v3 is the only supported shape
                // post-slim. Older files re-bootstrap from scratch as a new
                // session sees itx.
                return false;
            }
            for (const [k, mapRaw] of Object.entries(data.maps ?? {})) {
                const m = mapRaw as PersistedMap;
                const mapId = parseInt(k, 10);
                const interactives: RuntimeInteractive[] = (m.interactives ?? []).map((i) => ({
                    elementId: i.elementId,
                    cell: i.cell ?? null,
                    gfxId: i.gfxId ?? null,
                    typeId: i.typeId,
                    skillIds: [...(i.skillIds ?? [])],
                }));
                this.maps.set(mapId, { mapId, interactives, lastSeenAt: m.lastSeenAt });
            }
            return true;
        } catch (e) {
            console.warn("[map-interactives] load failed, starting fresh:", e);
            return false;
        }
    }
}
