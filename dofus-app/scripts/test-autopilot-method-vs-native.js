#!/usr/bin/env node
/* A/B compare `dtt.method("bbd").invoke()` (default) vs `NativeFunction(bbd.virtualAddress)`
 * for the same target. Helps diagnose whether the agent's call path matters
 * for engagement.
 *
 * Run:
 *   node test-autopilot-method-vs-native.js [targetMapId]
 *   default target: 88081176 (Village d'Amakna — known agent-rejection case)
 */

const HOST = process.env.DOFUS_HOST || "http://localhost:3001";
const TARGET = Number(process.argv[2]) || 88081176;

async function rpc(method, args = []) {
    const r = await fetch(`${HOST}/api/call`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    return (await r.json()).result;
}
async function curMap() { return rpc("getCurrentMapId"); }
async function deiy() { return (await rpc("snapshotDttState"))?.fields?.["<deiy>k__BackingField"]; }
async function abort() { return rpc("abortAutoTravel"); }

async function tryMethod(rpcName, label) {
    // Wait idle
    for (let i = 0; i < 10; i++) { await new Promise(r => setTimeout(r, 1000)); if (await deiy() === "false") break; }
    const start = await curMap();
    if (start === TARGET) { console.log(`[${label}] start === target, skip`); return null; }

    const t0 = Date.now();
    let res;
    try { res = await rpc(rpcName, [TARGET]); } catch (e) { res = { ok: false, reason: String(e).slice(0, 80) }; }
    await new Promise(r => setTimeout(r, 1500));
    const d = await deiy();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[${label}] start=${start} → bbd=${res.ok ? "ok" : "ERR"} (${(res.reason || "").slice(0, 30)}) deiy=${d} (${elapsed}s)`);
    if (d === "true") await abort();
    await new Promise(r => setTimeout(r, 1000));
    return d;
}

async function main() {
    console.log(`Target mapId: ${TARGET}`);
    console.log(`Player current: ${await curMap()}`);
    console.log();

    console.log("=== A: method.invoke (default) ===");
    const a = await tryMethod("autoTravelInstant", "method.invoke");

    console.log("\n=== B: NativeFunction (bypasses runtime_invoke) ===");
    const b = await tryMethod("autoTravelInstantNative", "NativeFunction");

    console.log("\n=== Round 2 (reverse order in case state interferes) ===");
    const b2 = await tryMethod("autoTravelInstantNative", "NativeFunction");
    const a2 = await tryMethod("autoTravelInstant", "method.invoke");

    console.log("\n=== SUMMARY ===");
    console.log(`method.invoke:  round1=${a}  round2=${a2}`);
    console.log(`NativeFunction: round1=${b}  round2=${b2}`);
    if (a === "true" || a2 === "true") console.log("→ method.invoke CAN engage this target");
    else console.log("→ method.invoke ALWAYS rejects this target");
    if (b === "true" || b2 === "true") console.log("→ NativeFunction CAN engage this target");
    else console.log("→ NativeFunction ALWAYS rejects this target");
}
main().catch(e => { console.error(e); process.exit(1); });
