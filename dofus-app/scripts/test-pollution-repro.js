#!/usr/bin/env node
// Reproduce the "one unreachable bricks the session" bug.
// Sequence: Amakna(0,0) → Amakna(0,1) → Justiciers → Amakna(0,1) → Amakna(0,0)
// The Justiciers call should silent-reject; subsequent calls should ALSO fail
// even though Amakna was reachable in step 1-2.
//
// Run with --reset to inject resetPathfinderState() between every bbd —
// proves whether the reset RPC fixes the corruption.

const HOST = "http://localhost:3001";
const USE_RESET = process.argv.includes("--reset");

const TARGETS = [
    { label: "Amakna (0,0)",  mid: 88212247, expect: "engage" },
    { label: "Amakna (0,1)",  mid: 88212246, expect: "engage" },
    { label: "Justiciers (0,0)", mid: 121897226, expect: "reject" },
    { label: "Amakna (0,1) AGAIN",  mid: 88212246, expect: "engage" },
    { label: "Amakna (0,0) AGAIN",  mid: 88212247, expect: "engage" },
];

async function rpc(method, args = []) {
    const r = await fetch(`${HOST}/api/call`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args }),
    });
    return (await r.json()).result;
}

async function deiy() {
    const s = await rpc("snapshotDttState");
    return s?.fields?.["<deiy>k__BackingField"];
}

async function fozSize() {
    // Probe foz collection sizes via the resetPathfinderState dry-run output —
    // we read the field counts directly via inspectInstance if available.
    // Simpler: read the cleaned[] from a NO-OP reset and count entries.
    // (The Clear() always succeeds, so the "cleaned" list reports anything
    // that was non-empty before clearing.)
    return null;  // skipped — we use the post-reset cleaned[] instead
}

async function probe(label, mid, expect) {
    const startMid = await rpc("getCurrentMapId");
    if (startMid === mid) {
        console.log(`  ${label.padEnd(28)} start === target, skip`);
        return "skip";
    }

    if (USE_RESET) {
        const r = await rpc("resetPathfinderState");
        if (r?.cleaned?.length) console.log(`  [reset]                     cleaned: ${r.cleaned.join(", ")}`);
    }

    await rpc("autoTravelInstant", [mid]);
    await new Promise(r => setTimeout(r, 1800));
    const d = await deiy();
    const ok = d === "true";
    const expected = expect === "engage" ? ok : !ok;
    console.log(`  ${label.padEnd(28)} → deiy=${d}  ${expected ? "PASS" : "FAIL"}  (expected ${expect})`);

    // Always abort+reset after, to keep test steps independent within USE_RESET=true.
    if (ok) {
        try { await rpc("abortAutoTravel"); } catch {}
        await new Promise(r => setTimeout(r, 500));
    }
    return expected ? "PASS" : "FAIL";
}

async function main() {
    console.log(`mode: ${USE_RESET ? "WITH resetPathfinderState between bbds" : "VANILLA (no reset)"}`);
    console.log(`start map: ${await rpc("getCurrentMapId")}`);
    console.log();
    let pass = 0, fail = 0, skip = 0;
    for (const t of TARGETS) {
        const r = await probe(t.label, t.mid, t.expect);
        if (r === "PASS") pass++;
        else if (r === "FAIL") fail++;
        else skip++;
    }
    console.log();
    console.log(`SUMMARY: pass=${pass}  fail=${fail}  skip=${skip}`);
    if (USE_RESET && fail === 0) console.log("→ resetPathfinderState fixes the corruption");
    else if (!USE_RESET && fail > 0) console.log("→ corruption confirmed without reset (re-run with --reset)");
}
main().catch(e => { console.error(e); process.exit(1); });
