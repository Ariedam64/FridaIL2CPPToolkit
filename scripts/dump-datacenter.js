// Driver — dump core DataCenter catalogues to .toolkit-data/datacenter/.
//
// Each root is dumped in series (RPC calls don't overlap) so the game stays
// responsive. Per-root id range is conservative: 0..MAX, where MAX is chosen
// by domain knowledge (monsters max ~20k, items ~30k, spells ~25k, etc.).
//
// Usage:
//   node scripts/dump-datacenter.js              # dump default set
//   node scripts/dump-datacenter.js Items 50000  # dump a single root with custom max

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3001", 10);
const OUT_DIR = path.resolve(__dirname, "..", ".toolkit-data", "datacenter");

function callRpc(method, args = [], timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ method, args });
        const req = http.request({
            host: "localhost", port: PORT, path: "/api/call", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            res.on("data", c => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`)); return; }
                try {
                    const data = JSON.parse(text);
                    if (data.error) reject(new Error(data.error));
                    else resolve(data.result);
                } catch (e) { reject(e); }
            });
        });
        req.on("timeout", () => { req.destroy(new Error("rpc timeout")); });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// Conservative max ids — better undershoot a bit than spend minutes on dead ranges.
const DEFAULT_TARGETS = [
    ["BreedsDataRoot",          50],
    ["JobsDataRoot",            300],
    ["CharacteristicsDataRoot", 200],
    ["AreasDataRoot",           5000],
    ["AchievementsDataRoot",    8000],
    ["InteractivesDataRoot",    800],
    ["EmoticonsDataRoot",       500],
    ["EffectsDataRoot",         5000],
    ["AlignmentSidesDataRoot",  20],
    ["AlignmentRanksDataRoot",  30],
    ["AlignmentTitlesDataRoot", 50],
    ["AlmanaxCalendarsDataRoot", 1000],
    ["ItemSetsDataRoot",        2000],
    ["ItemTypesDataRoot",       200],
    ["ItemsDataRoot",           30000],
    ["MapScrollActionsDataRoot", 2000],
];

async function dumpOne(root, max) {
    const t0 = Date.now();
    const r = await callRpc("dumpDataRoot", [root, 0, max], 10 * 60_000);
    const ms = Date.now() - t0;
    if (!r.found) {
        console.log(`  ${root.padEnd(30)} not found (${r.error})`);
        return;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${root}.json`);
    fs.writeFileSync(out, JSON.stringify(r, null, 0), "utf8");
    const size = (fs.statSync(out).size / 1024).toFixed(1);
    console.log(`  ${root.padEnd(30)} ${String(r.extractedCount).padStart(6)} entries · ${ms}ms · ${size} KB`);
}

(async () => {
    const single = process.argv[2];
    const customMax = process.argv[3] ? parseInt(process.argv[3], 10) : null;
    const targets = single
        ? [[single.endsWith("DataRoot") ? single : `${single}DataRoot`, customMax ?? 30000]]
        : DEFAULT_TARGETS;

    console.log(`dumping ${targets.length} root(s) → ${path.relative(process.cwd(), OUT_DIR)}/`);
    const t0 = Date.now();
    for (const [root, max] of targets) {
        try { await dumpOne(root, max); }
        catch (e) { console.log(`  ${root.padEnd(30)} FAIL: ${e.message}`); }
    }
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error("fatal:", e.message); process.exit(1); });
