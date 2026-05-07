#!/usr/bin/env node
// Travels through a fixed list of 50 maps sequentially to observe at which
// index the autopilot starts silent-rejecting (= "session bricked"). NO
// reset/clearStuck calls between bbds — we want the natural failure
// progression to see whether bricking is gradual (state accumulates over N
// bbds) or sudden (one specific transition kills it).
//
// Usage:  node dofus-app/scripts/test-50-maps-brick.js
// Optional: arg [n] to cap at first n maps (default 50)

const HOST = "http://localhost:3001";

const MAPS = [
    [208931846, 0, 0, "Atelier du Tanukouï Sa"],
    [195300356, 3, -17, "Planque des Vilinsekts"],
    [147063810, 4, -19, "Planque des Vilinsekts"],
    [189399809, 16, -24, "Village de Pandala"],
    [211027968, 23, -31, "Taverne interdite"],
    [211290112, 21, -33, "Jardin secret de Panda"],
    [211291136, 21, -33, "Jardin secret de Panda"],
    [206176772, 16, -33, "Feudala"],
    [206177797, 14, -32, "Feudala"],
    [190056961, 13, -28, "Calanques d'Astrub"],
    [190054401, 8, -28, "Calanques d'Astrub"],
    [190055682, 8, -31, "Calanques d'Astrub"],
    [189792256, 3, -31, "Champs d'Astrub"],
    [189530625, -1, -28, "Forêt d'Astrub"],
    [84805377, -3, -23, "Plaine des Porkass"],
    [188743687, 1, -15, "Cité d'Astrub"],
    [147062784, 6, -15, "Planque des Vilinsekts"],
    [190580228, 6, -10, "Prairies d'Astrub"],
    [88081177, 2, -2, "Village d'Amakna"],
    [88086803, 13, 4, "Côte d'Asse"],
    [88086799, 13, 8, "Coin des Boos"],
    [88086796, 13, 11, "Territoire des Bandits"],
    [117440514, 18, 11, "Tunnel de Kartonpath"],
    [117965312, 22, 8, "Île de Kartonpath"],
    [156762627, 27, 8, "Plage de la Tortue"],
    [156499970, 29, 8, "Jungle Interdite"],
    [156500482, 30, 8, "Jungle Interdite"],
    [156500481, 30, 7, "Jungle Interdite"],
    [156500992, 31, 6, "Jungle Interdite"],
    [156500737, 30, 5, "Chemin du Crâne"],
    [156501762, 32, 4, "Chemin du Crâne"],
    [158077952, 33, 3, "Chemin du Crâne"],
    [156893697, 34, 5, "Plage de la Tortue"],
    [156894724, 32, 8, "Plage de la Tortue"],
    [156500484, 30, 10, "Forêt des Masques"],
    [156499972, 29, 10, "Forêt des Masques"],
    [156762627, 27, 8, "Plage de la Tortue"],
    [117965312, 22, 8, "Île de Kartonpath"],
    [117442562, 18, 9, "Tunnel de Kartonpath"],
    [117443584, 17, 12, "Tunnel de Kartonpath"],
    [88087816, 15, 15, "Territoire des Bandits"],
    [88087811, 15, 20, "Territoire des Bandits"],
    [240386054, 18, 22, "Bassin des Muldos"],
    [90708227, 22, 22, "Sufokia"],
    [95423492, 26, 22, "Sufokia"],
    [240386055, 18, 23, "Bassin des Muldos"],
    [90703364, 13, 29, "Sufokia"],
    [115082755, 13, 34, "Temple des alliances"],
    [115081731, 13, 34, "Temple des alliances"],
    [115082755, 13, 34, "Temple des alliances"],
];

const CAP = parseInt(process.argv[2] || String(MAPS.length), 10);
const ENGAGE_PROBE_MS = 1500;
const STALL_MS = 12000;
const POLL_MS = 700;
const TOTAL_TIMEOUT_MS = 120000;

async function rpc(method, args = []) {
    const r = await fetch(`${HOST}/api/call`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function snapState() {
    try {
        const s = await rpc("snapshotDttState");
        const f = s?.fields ?? {};
        return {
            deiy: f["<deiy>k__BackingField"],
            deiz: f.deiz,
            dejo: f.dejo === null ? "null" : (typeof f.dejo === "string" ? "set" : "set"),
            dejp: f.dejp,
        };
    } catch { return { deiy: "?", deiz: "?", dejo: "?", dejp: "?" }; }
}

async function travel(target, label) {
    const t0 = Date.now();
    const startMap = await rpc("getCurrentMapId");
    if (startMap === target.mapId) return { res: "skip-same", elapsed: 0, startMap };

    try { await rpc("autoTravelInstant", [target.mapId]); } catch {}
    await sleep(ENGAGE_PROBE_MS);
    const engageState = await snapState();
    if (engageState.deiy !== "true") {
        return { res: "silent-reject", elapsed: Date.now() - t0, startMap, state: engageState };
    }

    let lastSeen = startMap;
    let lastChange = Date.now();
    while (Date.now() - t0 < TOTAL_TIMEOUT_MS) {
        await sleep(POLL_MS);
        const m = await rpc("getCurrentMapId");
        if (m === target.mapId) {
            const finalState = await snapState();
            return { res: "arrived", elapsed: Date.now() - t0, startMap, state: finalState };
        }
        if (m !== lastSeen) { lastSeen = m; lastChange = Date.now(); }
        if (Date.now() - lastChange > STALL_MS) {
            try { await rpc("abortAutoTravel"); } catch {}
            const stallState = await snapState();
            return { res: "stalled", elapsed: Date.now() - t0, startMap, lastSeen, state: stallState };
        }
    }
    try { await rpc("abortAutoTravel"); } catch {}
    return { res: "timeout", elapsed: Date.now() - t0, startMap, lastSeen };
}

function tag(res) {
    return res === "arrived" ? "✓" :
        res === "skip-same" ? "=" :
        res === "silent-reject" ? "✗reject" :
        res === "stalled" ? "~stall" :
        res === "timeout" ? "⏱" : "?";
}

async function main() {
    console.log(`>>> 50-maps brick test — cap=${CAP}, no reset/clearStuck between bbds`);
    const initState = await snapState();
    console.log(`init  map=${await rpc("getCurrentMapId")}  ${JSON.stringify(initState)}`);
    console.log();

    const stats = { arrived: 0, silent: 0, stalled: 0, timeout: 0, skip: 0 };
    let consecutiveFails = 0;
    let firstFailIdx = -1;
    const results = [];

    for (let i = 0; i < Math.min(CAP, MAPS.length); i++) {
        const [mapId, posX, posY, subArea] = MAPS[i];
        const target = { mapId, posX, posY, subArea };
        const r = await travel(target, `${i + 1}/${CAP}`);
        const stateStr = r.state ? ` deiy=${r.state.deiy} deiz=${r.state.deiz} dejp=${String(r.state.dejp).slice(0, 18)}` : "";
        console.log(`[${String(i + 1).padStart(2)}/${CAP}] ${tag(r.res)} ${r.res.padEnd(13)} ${(r.elapsed / 1000).toFixed(1).padStart(5)}s  ${String(mapId).padStart(10)} (${String(posX).padStart(3)},${String(posY).padStart(3)}) ${subArea.slice(0, 24).padEnd(24)}${stateStr}`);

        results.push({ idx: i + 1, mapId, ...r });
        if (r.res === "arrived") { stats.arrived++; consecutiveFails = 0; }
        else if (r.res === "skip-same") { stats.skip++; consecutiveFails = 0; }
        else if (r.res === "silent-reject") { stats.silent++; consecutiveFails++; if (firstFailIdx === -1) firstFailIdx = i + 1; }
        else if (r.res === "stalled") { stats.stalled++; consecutiveFails++; if (firstFailIdx === -1) firstFailIdx = i + 1; }
        else if (r.res === "timeout") { stats.timeout++; consecutiveFails++; if (firstFailIdx === -1) firstFailIdx = i + 1; }

        if (consecutiveFails >= 5) {
            console.log(`\n>>> 5 consecutive fails — session likely bricked at index ${i + 1}. Stopping.`);
            break;
        }
        // Tiny breath between maps so the previous arrival event has time to
        // settle (the agent's tkl event fires ~50-200ms after currentMapId
        // updates).
        await sleep(400);
    }

    console.log();
    console.log("SUMMARY:", stats);
    if (firstFailIdx > 0) console.log(`First fail at index ${firstFailIdx} (${MAPS[firstFailIdx - 1][0]} ${MAPS[firstFailIdx - 1][3]})`);
    else console.log("No fails — session survived all attempts.");
}
main().catch(e => { console.error(e); process.exit(1); });
