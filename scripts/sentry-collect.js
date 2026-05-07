// Driver for Sentry breadcrumb harvesting.
//
// Usage (assumes the toolkit server is running and attached to Dofus):
//   node scripts/sentry-collect.js install     # install all hooks
//   node scripts/sentry-collect.js stats       # quick counts
//   node scripts/sentry-collect.js dump [out]  # write breadcrumbs to JSON (default: .toolkit-data/sentry/run-<ts>.json)
//   node scripts/sentry-collect.js clear       # empty the in-agent buffer
//
// Recommended flow:
//   1) start Dofus, attach the toolkit, run "install"
//   2) play normally 5-15 minutes — visit zaaps, open inventory, enter a fight, …
//   3) run "dump" → analyze the resulting JSON offline

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OUT_DIR = path.resolve(__dirname, "..", ".toolkit-data", "sentry");

function callRpc(method, args = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ method, args });
        const req = http.request({
            host: "localhost", port: PORT, path: "/api/call", method: "POST",
            headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
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
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

async function cmdInstall() {
    const r = await callRpc("installSentryHooks", [true]);
    console.log(`installed ${r.installed} new hook(s), ${r.total} total`);
    for (const h of r.details) console.log(`  + ${h.klass}.${h.method}(${h.overload})`);
    if (r.installed === 0) {
        console.log("(no new hooks — either Sentry classes not found, or already installed)");
    }
}

async function cmdStats() {
    const s = await callRpc("getSentryStats", []);
    console.log(`total entries: ${s.total}`);
    console.log("by method:");
    for (const [m, n] of Object.entries(s.byMethod)) console.log(`  ${m.padEnd(20)} ${n}`);
    const cats = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 20);
    if (cats.length) {
        console.log("top categories:");
        for (const [c, n] of cats) console.log(`  ${c.padEnd(30)} ${n}`);
    }
    console.log(`hooks installed: ${s.hooks.length}`);
}

async function cmdDump(outArg) {
    const all = await callRpc("getSentryBreadcrumbs", [10000]);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const out = outArg || path.join(OUT_DIR, `run-${ts}.json`);
    fs.writeFileSync(out, JSON.stringify({ collectedAt: new Date().toISOString(), count: all.length, entries: all }, null, 2), "utf8");
    console.log(`wrote ${all.length} entries → ${out}`);

    // Surface the most useful slice up-front: distinct (category, message) pairs,
    // which are the labels Ankama dev hard-coded in source.
    const seen = new Map();
    for (const e of all) {
        if (e.method !== "AddBreadcrumb") continue;
        const key = `${e.category || "(none)"} :: ${e.message || ""}`;
        seen.set(key, (seen.get(key) || 0) + 1);
    }
    const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    if (top.length) {
        console.log("\ntop distinct breadcrumbs (category :: message → count):");
        for (const [k, n] of top) console.log(`  [${String(n).padStart(4)}]  ${k}`);
    }
}

async function cmdClear() {
    const n = await callRpc("clearSentryBreadcrumbs", []);
    console.log(`cleared ${n} entries`);
}

(async () => {
    const cmd = process.argv[2];
    try {
        switch (cmd) {
            case "install": await cmdInstall(); break;
            case "stats":   await cmdStats(); break;
            case "dump":    await cmdDump(process.argv[3]); break;
            case "clear":   await cmdClear(); break;
            default:
                console.log("Usage: node scripts/sentry-collect.js <install|stats|dump [out]|clear>");
                process.exit(1);
        }
    } catch (e) {
        console.error(`error: ${e.message}`);
        process.exit(1);
    }
})();
