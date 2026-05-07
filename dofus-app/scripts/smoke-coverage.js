#!/usr/bin/env node
// Mini-orchestrator: replay coverage panel logic from CLI for first N plan entries.
// Used to verify the panel flow works end-to-end after fixes, without touching UI.

const HOST = "http://localhost:3001";
const N = parseInt(process.argv[2] || "10", 10);

async function rpc(method, args = []) {
    const r = await fetch(`${HOST}/api/call`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    return (await r.json()).result;
}
async function deiy() {
    return (await rpc("snapshotDttState"))?.fields?.["<deiy>k__BackingField"];
}

async function tryCandidate(c) {
    const start = await rpc("getCurrentMapId");
    if (start === c.mapId) return { res: "skip-same", elapsed: 0 };
    const t0 = Date.now();
    try { await rpc("autoTravelInstant", [c.mapId]); } catch {}
    await new Promise(r => setTimeout(r, 1500));
    const d = await deiy();
    if (d !== "true") {
        try { await rpc("resetPathfinderState"); } catch {}
        return { res: "unreachable", elapsed: Date.now() - t0 };
    }
    // wait up to 60s for arrival, polling currentMapId
    let lastSeen = start;
    let lastChange = Date.now();
    while (Date.now() - t0 < 90000) {
        await new Promise(r => setTimeout(r, 800));
        const m = await rpc("getCurrentMapId");
        if (m === c.mapId) return { res: "arrived", elapsed: Date.now() - t0 };
        if (m !== lastSeen) { lastSeen = m; lastChange = Date.now(); }
        if (Date.now() - lastChange > 15000) {
            try { await rpc("abortAutoTravel"); } catch {}
            try { await rpc("resetPathfinderState"); } catch {}
            return { res: "stalled", elapsed: Date.now() - t0, lastSeen };
        }
    }
    try { await rpc("abortAutoTravel"); } catch {}
    return { res: "timeout", elapsed: Date.now() - t0, lastSeen };
}

async function main() {
    const plan = await fetch(`${HOST}/api/resource-plan`).then(r => r.json());
    const entries = plan.entries.slice(0, N);
    console.log(`Plan loaded: ${plan.entries.length} entries; running first ${entries.length}`);
    console.log(`Player start: ${await rpc("getCurrentMapId")}`);
    console.log();

    const stats = { arrived: 0, unreachable: 0, stalled: 0, timeout: 0, skipSame: 0, allFail: 0 };
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const cands = e.candidates.slice(0, 3); // try top 3 candidates per entry
        let outcome = null;
        for (let ci = 0; ci < cands.length; ci++) {
            const c = cands[ci];
            const r = await tryCandidate(c);
            const tag = r.res === "arrived" ? "✓" : r.res === "unreachable" ? "✗" : r.res === "stalled" ? "~" : r.res === "skip-same" ? "=" : "?";
            console.log(`  [${i + 1}/${entries.length}] gfx${e.gfxId.toString().padStart(7)}  cand${ci + 1}/${cands.length}  ${tag} ${r.res.padEnd(11)} ${(r.elapsed / 1000).toFixed(1)}s  → ${c.mapId} (${c.posX},${c.posY}) ${c.subArea.slice(0, 22)}`);
            outcome = r.res;
            if (r.res === "arrived" || r.res === "skip-same") break;
        }
        if (outcome === "arrived") stats.arrived++;
        else if (outcome === "skip-same") stats.skipSame++;
        else if (outcome === "unreachable") stats.allFail++;
        else stats.stalled++;
    }
    console.log();
    console.log("SUMMARY:", stats);
}
main().catch(e => { console.error(e); process.exit(1); });
