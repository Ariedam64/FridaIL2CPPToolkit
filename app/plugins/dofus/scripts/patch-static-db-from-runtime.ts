#!/usr/bin/env tsx
// Phase B: enrich the static DB with gfxIds + skillIds per typeId, learned by
// joining the per-map static `ie` triples with runtime `itx.eftt` captures.
//
// Run: npm run dofus:patch-static-db (from app/) — does NOT need Dofus attached.
//
// Inputs:
//   - app/plugins/dofus/data/static-db.json          (output of build-static-db)
//   - app/plugins/dofus/data/maps/<mapId>.json       (per-map static ie)
//   - .toolkit-data/maps-runtime.json                (runtime captures: elementId → typeId + skillIds)
//
// Output: app/plugins/dofus/data/static-db.json — enriched in-place.
//   interactives[typeId] gains:
//     - gfxIds:  array of gfxIds seen for this typeId, sorted by frequency desc then ascending
//     - skillIds: array of skillIds seen attached to this typeId
//     - mapCount: how many distinct maps had this typeId (rough popularity)
//
// Why this approach:
//   The bundle never carries typeId (only gfxId). The server's `itx` carries
//   typeId per elementId. The bridge is the elementId, present in both. So we
//   join per (mapId, elementId) and accumulate the (gfxId, typeId, skillIds)
//   triples seen across all visited maps.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const _DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_DIR, "../../../..");
const STATIC_DB = path.resolve(_DIR, "../data/static-db.json");
const MAPS_DIR = path.resolve(_DIR, "../data/maps");
const RUNTIME_FILE = path.join(REPO_ROOT, ".toolkit-data", "maps-runtime.json");

interface RuntimeSkill { skillId: number }
interface RuntimeInteractive { elementId: number; typeId: number; skills: RuntimeSkill[] }
interface RuntimeMap { mapId: number; interactives: RuntimeInteractive[]; lastSeenAt: number }
interface RuntimeFile { schemaVersion: number; maps: Record<string, RuntimeMap> }

interface MapStatic { mapId: number; ie?: Array<[number, number, number]> }

function readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

function loadStaticIeByElementId(mapId: number): Map<number, number> {
    const file = path.join(MAPS_DIR, `${mapId}.json`);
    if (!fs.existsSync(file)) return new Map();
    const m = readJson<MapStatic>(file);
    const out = new Map<number, number>();
    for (const triple of m.ie ?? []) {
        if (Array.isArray(triple) && triple.length >= 3) {
            const [, elementId, gfxId] = triple;
            out.set(elementId, gfxId);
        }
    }
    return out;
}

interface InteractiveEntry {
    name: string;
    gfxIds?: number[];
    skillIds?: number[];
    mapCount?: number;
}

function main(): void {
    if (!fs.existsSync(STATIC_DB)) {
        throw new Error(`Missing ${STATIC_DB}. Run npm run dofus:build-static-db first.`);
    }
    const db = readJson<{ interactives: Record<string, InteractiveEntry>; [k: string]: unknown }>(STATIC_DB);
    const runtime = readJson<RuntimeFile>(RUNTIME_FILE);
    const visited = Object.values(runtime.maps).filter((m) => m.lastSeenAt > 0);
    console.log(`static DB: ${Object.keys(db.interactives).length} interactives`);
    console.log(`runtime: ${visited.length} maps with captures, ${visited.reduce((a, m) => a + m.interactives.length, 0)} interactives total`);

    // typeId → { gfxIdCounts, skillIds, mapIds }
    const accumulator = new Map<number, {
        gfxCounts: Map<number, number>;
        skillIds: Set<number>;
        mapIds: Set<number>;
    }>();

    let joinedCount = 0;
    let unmatchedRuntime = 0;
    let missingStaticMap = 0;

    for (const rt of visited) {
        const mapId = Number(rt.mapId);
        const ieByElementId = loadStaticIeByElementId(mapId);
        if (ieByElementId.size === 0) {
            missingStaticMap++;
            continue;
        }
        for (const live of rt.interactives) {
            const tid = live.typeId;
            // Skip unresolved (-1) entries — can't anchor them to a name anyway.
            if (typeof tid !== "number" || tid < 0) continue;
            const gfxId = ieByElementId.get(live.elementId);
            if (gfxId === undefined) {
                // Runtime element not in static `ie`. Happens for server-side
                // dynamic spawns (elementIds outside the bundle's range). We
                // can still record skillIds + mapCount for the typeId.
                unmatchedRuntime++;
            }
            let acc = accumulator.get(tid);
            if (!acc) {
                acc = { gfxCounts: new Map(), skillIds: new Set(), mapIds: new Set() };
                accumulator.set(tid, acc);
            }
            if (gfxId !== undefined) {
                acc.gfxCounts.set(gfxId, (acc.gfxCounts.get(gfxId) ?? 0) + 1);
            }
            for (const s of live.skills ?? []) {
                if (typeof s.skillId === "number") acc.skillIds.add(s.skillId);
            }
            acc.mapIds.add(mapId);
            joinedCount++;
        }
    }

    console.log(`\njoined: ${joinedCount} runtime entries linked to a static gfx`);
    console.log(`  ${unmatchedRuntime} runtime entries had no matching static elementId (server-side dynamic spawns)`);
    console.log(`  ${missingStaticMap} runtime maps had no static .json file at all`);
    console.log(`  ${accumulator.size} distinct typeIds learned\n`);

    // Patch the DB. For each typeId in accumulator, sort gfxIds by frequency
    // descending, tie-break ascending. skillIds sorted ascending. Count = how
    // many distinct maps had this typeId (rough popularity signal).
    let patched = 0;
    for (const [tid, acc] of accumulator) {
        const entry = db.interactives[String(tid)];
        if (!entry) continue;  // typeId not in datacenter — skip
        const gfxIds = [...acc.gfxCounts.entries()]
            .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
            .map(([gfx]) => gfx);
        const skillIds = [...acc.skillIds].sort((a, b) => a - b);
        if (gfxIds.length > 0) entry.gfxIds = gfxIds;
        if (skillIds.length > 0) entry.skillIds = skillIds;
        entry.mapCount = acc.mapIds.size;
        patched++;
    }
    console.log(`patched ${patched} interactive entries in static DB`);

    // Sanity samples.
    const samples = ["1", "38", "17", "33", "100", "106", "300"];
    console.log("\nsample after patch:");
    for (const tid of samples) {
        const e = db.interactives[tid];
        if (e) {
            const skillsTxt = e.skillIds ? ` skills=[${e.skillIds.join(",")}]` : "";
            const gfxTxt = e.gfxIds ? ` gfxIds=[${e.gfxIds.slice(0, 5).join(",")}${e.gfxIds.length > 5 ? `,…+${e.gfxIds.length - 5}` : ""}]` : "";
            const mapTxt = e.mapCount ? ` (seen on ${e.mapCount} maps)` : " (never seen)";
            console.log(`  typeId=${tid} ${e.name}${gfxTxt}${skillsTxt}${mapTxt}`);
        }
    }

    fs.writeFileSync(STATIC_DB, JSON.stringify(db, null, 2), "utf-8");
    console.log(`\n→ Wrote ${STATIC_DB}`);
}

try {
    main();
} catch (e) {
    console.error("FAILED:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
}
