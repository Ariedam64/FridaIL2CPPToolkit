#!/usr/bin/env node
/* Exploratory: discover the obfuscated MapRenderer method that loads a map's
 * bundle data into runtime state (and fills the `dvi` interactive cache).
 *
 * Once we know the right method, the next step is a "force-load every mapId"
 * orchestrator that builds a complete gfxId → typeId table covering caves
 * and dungeons (which today are missing from gfx-to-type.json because their
 * sprites are never loaded during normal play).
 *
 * Usage:
 *   1. Make sure dofus-app host is running and attached to Dofus:
 *        npm run host:dofus
 *   2. List ranked candidates (top 15 most-likely "load" methods):
 *        node dofus-app/scripts/find-map-loader.js
 *   3. Pick one and probe it. Test target = a cave map (192413706, 14 ie):
 *        node dofus-app/scripts/find-map-loader.js --probe <methodName>
 *      For static methods:
 *        node dofus-app/scripts/find-map-loader.js --probe static:LoadMap
 *
 * What "success" looks like for the probe:
 *   - before.dviCount: small (current map's interactive count, e.g. 5–60)
 *   - after.dviCount:  larger or different (cave's 14 entries)
 *   - sampleNew shows entries with cutn matching expected cave types
 *   - currentMapId may flip to the target — that's OK; the orchestrator will
 *     iterate without character movement (server might disconnect though).
 *
 * Failure modes:
 *   - "method not found": pick another candidate
 *   - "invoke threw": method has wrong signature, pick another
 *   - dviCount unchanged: method exists but doesn't load — pick another
 */

const HOST = process.env.DOFUS_HOST || "http://localhost:3001";

// Test cave: map 192413706 = (5,-19) on wm=-1, has 11 cave-iron interactives
// (gfx 63846-63856) all UNKNOWN in current gfx-to-type.json. If a load method
// works, sampleNew should show entries with cutn=17 (Fer typeId).
const PROBE_MAP_ID = 192413706;

async function rpc(method, args = []) {
    const res = await fetch(`${HOST}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const j = await res.json();
    return j.result;
}

async function listCandidates() {
    console.log(`fetching MapRenderer + dvi class definitions…`);
    const r = await rpc("findMapLoaderCandidates");
    if (!r) { console.error("RPC returned nothing — is the host attached?"); return; }
    console.log(`\n${r.note}\n`);

    if (r.mapRenderer) {
        console.log("── MapRenderer top-15 candidate methods (sorted by rank) ──");
        const top = r.mapRenderer.methods.slice(0, 15);
        for (const m of top) {
            const sig = `${m.isStatic ? "static " : ""}${m.name}(${m.paramTypes.join(", ")}) → ${m.returnType}`;
            console.log(`  rank=${String(m.rank).padStart(3)} ${sig.padEnd(60)}  [${m.why}]`);
        }
        console.log(`\n  (… ${r.mapRenderer.methods.length - 15} more methods omitted)`);
        console.log(`\n  MapRenderer fields (first 20):`);
        for (const f of r.mapRenderer.fields.slice(0, 20)) {
            console.log(`    ${f.name}: ${f.type}`);
        }
    } else {
        console.log("MapRenderer NOT FOUND — is the game attached and at the main menu past intro?");
    }

    if (r.dviContainer) {
        console.log(`\n── ${r.dviContainer.className} (the dvi class itself) — top 8 methods ──`);
        for (const m of r.dviContainer.methods.slice(0, 8)) {
            const sig = `${m.isStatic ? "static " : ""}${m.name}(${m.paramTypes.join(", ")}) → ${m.returnType}`;
            console.log(`  rank=${String(m.rank).padStart(3)} ${sig.padEnd(60)}  [${m.why}]`);
        }
    }
    console.log(`\nNext step:  node dofus-app/scripts/find-map-loader.js --probe <methodName>`);
    console.log(`Test target: cave at (5,-19) wm=-1 — mapId ${PROBE_MAP_ID}`);
    console.log(`If a probe shifts dvi entries to cutn=17 (Fer), it loads cave-iron successfully.\n`);
}

async function probe(methodName) {
    // methodName format: "<methodName>" (assumes MapRenderer)
    //                 OR "<className>.<methodName>" (e.g. "dvi.txz")
    //                 OR "<className>.static:<methodName>"
    const display = methodName.includes(".") ? methodName : `MapRenderer.${methodName}`;
    console.log(`probing ${display}(${PROBE_MAP_ID})  (cave with iron)…`);
    const r = await rpc("probeMapLoadOn", [methodName, PROBE_MAP_ID]);
    if (!r) { console.error("probe returned nothing"); return; }
    console.log(`\nok=${r.ok}  invoke=${r.invokeMs}ms`);
    if (r.error) console.log(`error: ${r.error}`);
    console.log(`before:  dviCount=${r.before.dviCount}  currentMapId=${r.before.currentMapId}`);
    console.log(`after:   dviCount=${r.after.dviCount}   currentMapId=${r.after.currentMapId}`);
    if (r.sampleNew && r.sampleNew.length) {
        console.log(`\nsampleNew (${r.sampleNew.length} new entries):`);
        for (const e of r.sampleNew) {
            console.log(`  elementId=${e.elementId}  cell=${e.cell}  cutm=${e.cutm}  cutn=${e.cutn}` +
                        (e.cutn === 17 ? "   ← Fer (typeId 17) — JACKPOT 🎯" : ""));
        }
    } else {
        console.log(`\nno new dvi entries — method probably doesn't trigger map-load`);
    }
}

async function main() {
    const probeArg = process.argv.indexOf("--probe");
    if (probeArg !== -1 && process.argv[probeArg + 1]) {
        await probe(process.argv[probeArg + 1]);
    } else {
        await listCandidates();
    }
}
main().catch(e => { console.error(e); process.exit(1); });
