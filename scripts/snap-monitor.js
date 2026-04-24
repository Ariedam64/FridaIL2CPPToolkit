#!/usr/bin/env node
/* Listen to WS autopilot-done events, snapshot dtt state after each,
 * save to .toolkit-data/dtt-snaps/<index>-<mapId>.json for later diff. */
const fs = require("fs");
const path = require("path");
const http = require("http");

const OUT_DIR = path.resolve(__dirname, "..", ".toolkit-data", "dtt-snaps");
fs.mkdirSync(OUT_DIR, { recursive: true });

let idx = 0;

function rpc(method, args = []) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ method, args });
        const req = http.request({
            hostname: "localhost", port: 3000, path: "/api/call",
            method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        }, res => {
            let chunks = "";
            res.on("data", c => chunks += c);
            res.on("end", () => { try { resolve(JSON.parse(chunks).result); } catch (e) { reject(e); } });
        });
        req.on("error", reject);
        req.write(body); req.end();
    });
}

async function snap(label) {
    const mapId = await rpc("getCurrentMapId");
    const result = await rpc("snapshotDttState");
    const i = ++idx;
    const file = path.join(OUT_DIR, `${String(i).padStart(3, "0")}-${label}-${mapId}.json`);
    fs.writeFileSync(file, JSON.stringify({ idx: i, label, mapId, ts: Date.now(), ...result }, null, 2));
    console.log(`[${i}] ${label} mapId=${mapId} → ${path.basename(file)}`);
}

const WebSocket = require("ws");
const ws = new WebSocket("ws://localhost:3000/ws");

ws.on("open", () => console.log("[monitor] connected, waiting for autopilot-done events..."));
ws.on("message", async (raw) => {
    try {
        const ev = JSON.parse(raw.toString());
        if (ev.type !== "message") return;
        const m = ev.message;
        if (m?.type === "autopilot-done") {
            try { await snap("arrival"); } catch (e) { console.error("snap failed:", e.message); }
        }
    } catch {}
});
ws.on("close", () => console.log("[monitor] ws closed"));
ws.on("error", (e) => console.error("[monitor] ws err:", e.message));
