#!/usr/bin/env tsx
// Build Dofus plugin static index files from canonical-coords + datacenter dump.
// Run: npm run dofus:build-data (from app/) OR npx tsx <this file> (from anywhere).
//
// Inputs (all live inside the plugin under data/_build-inputs/):
//   Primary:  canonical-coords/canonical-coords-wm*.json
//             Format: { "x,y": mapId, ... }  — one file per worldMap id
//   Enrich:   datacenter/MapsInformationDataRoot.json
//             Sparse (13 entries), but has real subAreaId/nameId/name
//   Support:  datacenter/{AreasDataRoot, SubAreasDataRoot, WorldMapsDataRoot}.json
//
// Outputs (written to app/plugins/dofus/data/):
//   - maps-information.json  — ~17k entries
//   - areas.json

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorldDims } from "../lib/movement/world-dims";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(_DIR, "..");
const BUILD_INPUTS = path.join(PLUGIN_ROOT, "data", "_build-inputs");
const DC_DIR = path.join(BUILD_INPUTS, "datacenter");
const COORDS_DIR = path.join(BUILD_INPUTS, "canonical-coords");
const OUT_DIR = path.join(PLUGIN_ROOT, "data");

// Raw wrapped format from the datacenter dump
interface DcWrapper<T> {
    cls: string;
    items: Array<{ id: number; fields: T }>;
    extractedCount?: number;
}

interface DcMapFields {
    id: number;
    posX: number;
    posY: number;
    subAreaId: number;
    worldMap: number;
    nameId?: number;
    m_name?: string;
}

interface DcAreaFields {
    id: number;
    nameId?: number;
    m_name?: string;
}

interface DcSubAreaFields {
    id: number;
    areaId: number;
    nameId?: number;
    m_name?: string;
}

interface DcWorldFields {
    id: number;
    nameId?: number;
    m_name?: string;
    origineX?: number; origineY?: number;
    mapWidth?: number; mapHeight?: number;
    totalWidth?: number; totalHeight?: number;
    m_origineX?: number; m_origineY?: number;
    m_mapWidth?: number; m_mapHeight?: number;
    m_totalWidth?: number; m_totalHeight?: number;
}

interface MapInfoEntry {
    mapId: number;
    posX: number;
    posY: number;
    subAreaId: number;
    worldMap: number;
    nameId: number;
    name: string;
}

function readJson<T>(p: string): T {
    if (!fs.existsSync(p)) {
        throw new Error(
            `required file not found: ${p}\n` +
            `(run the datacenter dump first — see scripts/dump-datacenter.js at repo root)`,
        );
    }
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function readJsonOpt<T>(p: string, fallback: T): T {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

/** Unwrap the { items: [{id, fields}] } envelope used by the Frida datacenter dump. */
function unwrap<T>(wrapper: DcWrapper<T> | T[]): T[] {
    if (Array.isArray(wrapper)) return wrapper;
    if (wrapper && typeof wrapper === "object" && "items" in wrapper) {
        return (wrapper as DcWrapper<T>).items.map((item) => item.fields);
    }
    return [];
}

function nameOrId(o: { m_name?: string; name?: string; nameId?: number; id: number }): string {
    if (o.m_name) return o.m_name;
    if (o.name) return o.name;
    if (o.nameId !== undefined && o.nameId !== 0) return `#${o.nameId}`;
    return `id-${o.id}`;
}

/**
 * Read all canonical-coords-wm*.json files and build a map of mapId → {posX, posY, worldMap}.
 *
 * Filename convention:
 *   canonical-coords-wm-1.json  → worldMap = -1  (the dash IS the minus sign)
 *   canonical-coords-wm1.json   → worldMap = 1
 *   canonical-coords-wm10.json  → worldMap = 10
 */
function loadCanonicalCoords(): Map<number, { posX: number; posY: number; worldMap: number }> {
    const out = new Map<number, { posX: number; posY: number; worldMap: number }>();
    if (!fs.existsSync(COORDS_DIR)) {
        console.warn(`[dofus:build-data] coords dir not found: ${COORDS_DIR}`);
        return out;
    }

    // Match both wm-1.json (world -1) and wm1.json (world 1), wm10.json, etc.
    const files = fs.readdirSync(COORDS_DIR).filter((f) =>
        /^canonical-coords-wm(-?\d+)\.json$/.test(f),
    );

    // Track which worlds are loaded to detect duplicates
    const seenWorld = new Map<number, string>();

    // Sort deterministically (lexicographic); process all files
    files.sort();

    for (const f of files) {
        const m = /^canonical-coords-wm(-?\d+)\.json$/.exec(f);
        if (!m) continue;
        const worldMap = parseInt(m[1], 10);

        if (seenWorld.has(worldMap)) {
            console.warn(
                `[dofus:build-data] world ${worldMap} already loaded from ${seenWorld.get(worldMap)}, skipping ${f}`,
            );
            continue;
        }
        seenWorld.set(worldMap, f);

        const raw = JSON.parse(
            fs.readFileSync(path.join(COORDS_DIR, f), "utf8"),
        ) as Record<string, number>;

        let count = 0;
        for (const [coord, mapId] of Object.entries(raw)) {
            const commaIdx = coord.indexOf(",");
            if (commaIdx === -1) continue;
            const posX = parseInt(coord.slice(0, commaIdx), 10);
            const posY = parseInt(coord.slice(commaIdx + 1), 10);
            if (!Number.isFinite(posX) || !Number.isFinite(posY)) continue;
            out.set(mapId, { posX, posY, worldMap });
            count++;
        }
        console.log(`[dofus:build-data] coords wm=${worldMap} ← ${f} (${count} entries)`);
    }

    console.log(`[dofus:build-data] canonical-coords total: ${out.size} unique maps across ${seenWorld.size} worlds`);
    return out;
}

function main(): void {
    console.log(`[dofus:build-data] reading from ${DC_DIR} + ${COORDS_DIR}`);

    // --- Primary source: canonical coords ---
    const coords = loadCanonicalCoords();

    // --- Enrichment source: sparse datacenter dump ---
    const rawMaps = readJsonOpt<DcWrapper<DcMapFields> | DcMapFields[]>(
        path.join(DC_DIR, "MapsInformationDataRoot.json"),
        [],
    );
    const rawAreas = readJsonOpt<DcWrapper<DcAreaFields> | DcAreaFields[]>(
        path.join(DC_DIR, "AreasDataRoot.json"),
        [],
    );
    const rawSubAreas = readJsonOpt<DcWrapper<DcSubAreaFields> | DcSubAreaFields[]>(
        path.join(DC_DIR, "SubAreasDataRoot.json"),
        [],
    );
    const rawWorlds = readJsonOpt<DcWrapper<DcWorldFields> | DcWorldFields[]>(
        path.join(DC_DIR, "WorldMapsDataRoot.json"),
        [],
    );

    const dcMaps = unwrap(rawMaps);
    const dcAreas = unwrap(rawAreas);
    const dcSubAreas = unwrap(rawSubAreas);
    const dcWorlds = unwrap(rawWorlds);

    fs.mkdirSync(OUT_DIR, { recursive: true });

    // --- Build entries from canonical-coords (primary source) ---
    const byMapId = new Map<number, MapInfoEntry>();
    for (const [mapId, { posX, posY, worldMap }] of coords) {
        byMapId.set(mapId, {
            mapId,
            posX,
            posY,
            subAreaId: 0,
            worldMap,
            nameId: 0,
            name: `Map ${mapId}`,
        });
    }

    // --- Enrich from MapsInformation dump ---
    let enrichedCount = 0;
    for (const m of dcMaps) {
        if (m.id == null) continue;
        const existing = byMapId.get(m.id);
        if (existing) {
            // Overwrite placeholder values with real datacenter data
            existing.subAreaId = m.subAreaId ?? existing.subAreaId;
            existing.nameId = m.nameId ?? existing.nameId;
            existing.name = nameOrId({ m_name: m.m_name, nameId: m.nameId, id: m.id });
            enrichedCount++;
        } else {
            // MapsInformation has a map not in coords — add it too
            byMapId.set(m.id, {
                mapId: m.id,
                posX: m.posX ?? 0,
                posY: m.posY ?? 0,
                subAreaId: m.subAreaId ?? 0,
                worldMap: m.worldMap ?? 0,
                nameId: m.nameId ?? 0,
                name: nameOrId({ m_name: m.m_name, nameId: m.nameId, id: m.id }),
            });
            enrichedCount++;
        }
    }

    // --- Write maps-information.json ---
    const mapsOut = Array.from(byMapId.values()).sort((a, b) => a.mapId - b.mapId);
    fs.writeFileSync(
        path.join(OUT_DIR, "maps-information.json"),
        JSON.stringify(mapsOut),
        "utf8",
    );
    console.log(
        `[dofus:build-data] wrote maps-information.json — ${mapsOut.length} maps (${enrichedCount} enriched from datacenter)`,
    );

    // --- Write areas.json (unchanged logic) ---
    const areasOut = {
        areas: Object.fromEntries(
            dcAreas.map((a) => [a.id, { id: a.id, name: nameOrId(a) }]),
        ),
        subAreas: Object.fromEntries(
            dcSubAreas.map((s) => [s.id, { id: s.id, areaId: s.areaId, name: nameOrId(s) }]),
        ),
        worlds: Object.fromEntries(
            dcWorlds.length > 0
                ? dcWorlds.map((w) => {
                    const dims = extractWorldDims(w);
                    return [w.id, { id: w.id, name: nameOrId(w), ...(dims ? { dims } : {}) }];
                })
                : HARDCODED_WORLDS.map((w) => [w.id, w]),
        ),
    };
    fs.writeFileSync(
        path.join(OUT_DIR, "areas.json"),
        JSON.stringify(areasOut, null, 2),
        "utf8",
    );
    console.log(
        `[dofus:build-data] wrote areas.json — ${Object.keys(areasOut.worlds).length} worlds`,
    );

    console.log("[dofus:build-data] done.");
}

const HARDCODED_WORLDS: Array<{ id: number; name: string }> = [
    { id: -1, name: "Caves" },
    { id: 1,  name: "Amakna" },
    { id: 2,  name: "Wabbit Island" },
    { id: 3,  name: "Cania" },
    { id: 4,  name: "Sidimote" },
    { id: 5,  name: "Sufokia" },
    { id: 6,  name: "Otomai" },
    { id: 7,  name: "Islands" },
    { id: 8,  name: "Srambad" },
    { id: 9,  name: "Enutrosor" },
    { id: 10, name: "Frigost" },
    { id: 12, name: "Otomai" },
    { id: 13, name: "Saharach" },
    { id: 14, name: "Brakmar" },
    { id: 15, name: "Pandala" },
    { id: 16, name: "Bonta" },
    { id: 17, name: "Astrub" },
    { id: 18, name: "Incarnam" },
];

main();
