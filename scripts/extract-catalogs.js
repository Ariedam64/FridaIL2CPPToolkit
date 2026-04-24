// Standalone extraction driver — runs on the host side, calls each agent
// RPC in sequence, persists result to .toolkit-data/catalog/<name>.json.
// Use when the toolkit server is already running.
//
// Usage: node scripts/extract-catalogs.js

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_DIR = path.resolve(__dirname, "..", ".toolkit-data");
const CATALOG_DIR = path.join(DATA_DIR, "catalog");

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
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)); return; }
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

function saveCatalog(name, items) {
    fs.mkdirSync(CATALOG_DIR, { recursive: true });
    const file = path.join(CATALOG_DIR, `${name}.json`);
    const body = { name, count: items.length, updatedAt: new Date().toISOString(), items };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return { file: path.relative(DATA_DIR, file), size: fs.statSync(file).size };
}

const EXTRACTORS = [
    ["maps",         "extractMapsCatalog"],
    ["interactives", "extractInteractivesCatalog"],
    ["skillnames",   "extractSkillNamesCatalog"],
    ["subareas",     "extractSubAreasCatalog"],
    ["areas",        "extractAreasCatalog"],
    ["items",        "extractItemsCatalog"],
    ["jobs",         "extractJobsCatalog"],
    ["skills",       "extractSkillsCatalog"],
    ["monsters",     "extractMonstersCatalog"],
];

(async () => {
    const t0 = Date.now();
    console.log(`Extracting to ${CATALOG_DIR}`);
    for (const [name, method] of EXTRACTORS) {
        process.stdout.write(`  ${name.padEnd(14)} `);
        try {
            const r = await callRpc(method);
            const items = r.items || [];
            const saved = saveCatalog(name, items);
            console.log(`${items.length.toString().padStart(6)} entries → ${saved.file} (${(saved.size / 1024).toFixed(1)} KB)`);
        } catch (e) {
            console.log(`FAIL: ${e.message}`);
        }
    }
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
