#!/usr/bin/env tsx
// Build Dofus plugin static index files from a datacenter dump.
// Run: npm run dofus:build-data (from app/) OR npx tsx <this file> (from anywhere).
//
// Inputs (read from <repo-root>/.toolkit-data/datacenter/):
//   - MapsInformationDataRoot.json
//   - AreasDataRoot.json
//   - SubAreasDataRoot.json
//   - WorldMapsDataRoot.json
//
// Outputs (written to app/plugins/dofus/data/):
//   - maps-information.json
//   - areas.json
//
// NOTE: The datacenter dump files use a wrapper format:
//   { cls, items: [{ id, fields: { ...actualFields } }] }
// This script unwraps that format. The m_name field (when present) provides
// the resolved string name; otherwise we fall back to nameId display.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_DIR, "../../../..");
const DC_DIR = path.join(REPO_ROOT, ".toolkit-data", "datacenter");
const OUT_DIR = path.resolve(_DIR, "../data");

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
}

function readJson<T>(p: string): T {
    if (!fs.existsSync(p)) {
        throw new Error(
            `required file not found: ${p}\n` +
            `(run the datacenter dump first — see dofus-app/scripts/dump-datacenter.js)`,
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

function nameOrId(o: { m_name?: string; nameId?: number; id: number }): string {
    if (o.m_name) return o.m_name;
    if (o.nameId !== undefined && o.nameId !== 0) return `#${o.nameId}`;
    return `id-${o.id}`;
}

function main(): void {
    console.log(`[dofus:build-data] reading from ${DC_DIR}`);

    const rawMaps = readJson<DcWrapper<DcMapFields> | DcMapFields[]>(
        path.join(DC_DIR, "MapsInformationDataRoot.json"),
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

    // maps-information.json
    const mapsOut = dcMaps
        .filter((m) => m.id != null && m.worldMap != null)
        .map((m) => ({
            mapId: m.id,
            posX: m.posX ?? 0,
            posY: m.posY ?? 0,
            subAreaId: m.subAreaId ?? 0,
            worldMap: m.worldMap,
            nameId: m.nameId ?? 0,
            name: nameOrId({ m_name: undefined, nameId: m.nameId, id: m.id }),
        }));
    fs.writeFileSync(
        path.join(OUT_DIR, "maps-information.json"),
        JSON.stringify(mapsOut),
        "utf8",
    );
    console.log(`[dofus:build-data] wrote maps-information.json — ${mapsOut.length} maps`);

    // areas.json
    const areasOut = {
        areas: Object.fromEntries(
            dcAreas.map((a) => [a.id, { id: a.id, name: nameOrId(a) }]),
        ),
        subAreas: Object.fromEntries(
            dcSubAreas.map((s) => [s.id, { id: s.id, areaId: s.areaId, name: nameOrId(s) }]),
        ),
        worlds: Object.fromEntries(
            dcWorlds.length > 0
                ? dcWorlds.map((w) => [w.id, { id: w.id, name: nameOrId(w) }])
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
