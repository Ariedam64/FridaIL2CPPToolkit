// Driver — dump the runtime gbe router (Protobuf message → handler mapping).
//
// Prereq: toolkit server running, attached to Dofus, gbe singleton initialized
// (it's created early — usually safe to dump as soon as the login screen shows).
//
// Usage:
//   node scripts/dump-gbe-router.js [out-file]
//   default out: .toolkit-data/gbe-router/run-<ts>.json

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const OUT_DIR = path.resolve(__dirname, "..", ".toolkit-data", "gbe-router");

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

(async () => {
    const r = await callRpc("dumpGbeRouter", [5000]);
    if (!r.found) {
        console.log("gbe singleton not found:");
        for (const n of r.notes) console.log("  - " + n);
        process.exit(1);
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const out = process.argv[2] || path.join(OUT_DIR, `run-${ts}.json`);
    fs.writeFileSync(out, JSON.stringify(r, null, 2), "utf8");

    let total = 0;
    for (const d of r.dispatchers) {
        console.log(`dispatcher ${d.fieldName} (${d.runtimeCls}): ${d.entryCount} entries via ${d.dictFieldName} (${d.dictType})`);
        total += d.entryCount;
        // print first 5 + tail to give a sense of the shape
        const sample = d.entries.slice(0, 5);
        for (const e of sample) {
            const h = e.handler ? `${e.handler.cls}${e.handler.delegate?.target?.cls ? " → " + e.handler.delegate.target.cls : ""}${e.handler.delegate?.method ? "." + e.handler.delegate.method : ""}` : "(no handler info)";
            console.log(`    ${e.typeShortName.padEnd(8)}  ${e.typeName.padEnd(50)}  ${h}`);
        }
        if (d.entries.length > 5) console.log(`    … +${d.entries.length - 5} more`);
    }
    console.log(`\ntotal routing entries: ${total}`);
    console.log(`written: ${out}`);
})().catch(e => { console.error("error:", e.message); process.exit(1); });
