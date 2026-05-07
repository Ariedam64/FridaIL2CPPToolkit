#!/usr/bin/env node
/* Probe each plan target individually to determine reachability from current
 * player position. Outputs reachable/unreachable lists.
 *
 * Methodology per target:
 *   1. Capture current mapId (start vertex)
 *   2. Fire autoTravelInstant(target)
 *   3. Wait 1.5s for the path solver to complete
 *   4. Read dtt.<deiy>k__BackingField:
 *        true  → engaged → REACHABLE
 *        false → rejected → UNREACHABLE (or pathfinder confused)
 *   5. If engaged, abort immediately to avoid actually walking
 *   6. Wait 1s between probes
 *
 * Caveats:
 *   - "REACHABLE" via this probe = whatever the agent's bbd codepath accepts.
 *     The UI may accept additional targets via different code path.
 *   - Aborting an engaged autopilot may briefly leave residual state. Probe
 *     order may matter in pathological cases — re-run if results look off.
 *
 * Usage:
 *   node test-autopilot-reachability.js [coverage-plan.json]
 *   node test-autopilot-reachability.js --max 20    # only first 20
 */

const HOST = process.env.DOFUS_HOST || "http://localhost:3001";

async function rpc(method, args = []) {
    const r = await fetch(`${HOST}/api/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    return (await r.json()).result;
}
async function curMap() { return rpc("getCurrentMapId"); }
async function deiy() {
    const s = await rpc("snapshotDttState");
    return s?.fields?.["<deiy>k__BackingField"];
}

async function probe(targetMapId) {
    const start = await curMap();
    if (start === targetMapId) return { result: "same", time: 0 };

    const t0 = Date.now();
    let bbdResult;
    try {
        bbdResult = await rpc("autoTravelInstant", [targetMapId]);
    } catch (e) {
        return { result: "error", time: Date.now() - t0, error: String(e).slice(0, 80) };
    }

    await new Promise(r => setTimeout(r, 1500));
    const d = await deiy();

    let result;
    if (d === "true") {
        result = "reachable";
        // Cancel before player actually walks far
        try { await rpc("abortAutoTravel"); } catch {}
        await new Promise(r => setTimeout(r, 500));
    } else {
        result = "unreachable";
    }
    return { result, time: Date.now() - t0, bbdOk: bbdResult.ok, bbdReason: bbdResult.reason };
}

async function main() {
    const planPath = process.argv.find(a => a.endsWith(".json")) || "../data/coverage-plan.json";
    const maxArg = process.argv.indexOf("--max");
    const max = maxArg !== -1 ? parseInt(process.argv[maxArg + 1], 10) : Infinity;

    let plan;
    try {
        const fs = require("fs");
        const path = require("path");
        const full = path.resolve(__dirname, planPath);
        plan = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch (e) {
        console.error("Failed to load plan:", planPath, e.message);
        process.exit(1);
    }

    const targets = plan.maps.slice(0, max);
    console.log(`Probing ${targets.length} targets from coverage-plan.json`);
    console.log(`Start position: ${await curMap()}`);
    console.log();

    const reachable = [];
    const unreachable = [];

    for (let i = 0; i < targets.length; i++) {
        const m = targets[i];
        const r = await probe(m.mapId);
        const tag = r.result === "reachable" ? "✓ REACH" :
                    r.result === "unreachable" ? "✗ UNREACH" :
                    r.result === "same" ? "= SAME" : "! ERR";
        console.log(`[${(i + 1).toString().padStart(3)}/${targets.length}] ${tag}  mid=${m.mapId.toString().padStart(10)}  (${m.posX.toString().padStart(4)},${m.posY.toString().padStart(4)})  wm=${m.worldMap.toString().padStart(3)}  ${m.subArea}  (${(r.time / 1000).toFixed(1)}s)`);
        if (r.result === "reachable") reachable.push(m);
        else if (r.result === "unreachable") unreachable.push(m);
    }

    console.log();
    console.log(`SUMMARY: ${reachable.length} reachable / ${unreachable.length} unreachable / ${targets.length - reachable.length - unreachable.length} other`);

    // Write reachable-only plan for retry
    if (reachable.length) {
        const fs = require("fs");
        const path = require("path");
        const out = path.resolve(__dirname, "../data/coverage-plan-reachable.json");
        const reorderedReach = reachable.map((m, i) => ({ ...m, order: i + 1 }));
        fs.writeFileSync(out, JSON.stringify({
            note: `Filtered from coverage-plan.json — only walking-reachable from position ${await curMap()}`,
            generatedAt: new Date().toISOString(),
            stats: { totalProbed: targets.length, reachable: reachable.length, unreachable: unreachable.length },
            maps: reorderedReach,
        }, null, 2), "utf8");
        console.log(`\nWrote reachable-only plan: ${out}`);
        console.log(`To use: cp coverage-plan-reachable.json coverage-plan.json && relaunch RUN COVERAGE PLAN`);
    }
}
main().catch(e => { console.error(e); process.exit(1); });
