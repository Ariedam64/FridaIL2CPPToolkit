#!/usr/bin/env node
/* =============================================================================
 * Dofus app — local HTTP + WebSocket host (port 3001)
 * =============================================================================
 * Shares the toolkit's Frida bridge (loads the same build/rpc-agent.js).
 * Runs as its own node process — only one Frida client can attach at a time,
 * so do not start the toolkit's `npm run host` simultaneously.
 *
 * Run:   npm run host:dofus
 * Open:  http://localhost:3001
 * =============================================================================
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const bridge      = require("../host/lib/frida-bridge");
const wsModule    = require("../host/lib/ws");
const { makeHandler, sendJson, readBody } = require("../host/lib/router");
const persistence = require("./lib/persistence");
const { broadcast } = wsModule;

const PORT       = parseInt(process.env.PORT || "3001", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------- wire bridge events ------------------------------------------------
bridge.on("attached", (info) => broadcast({ type: "attached", ...info }));
bridge.on("detached", (e) => broadcast({ type: "detached", reason: e.reason }));
bridge.on("message", (m, data) => {
    try {
        const p = m && m.payload;
        if (p && p.type === "full-capture" && p.cls && p.tree) {
            const saved = persistence.saveCapture(p.cls, { cls: p.cls, ts: p.ts, tree: p.tree });
            console.log(`[dofus] persisted full-capture for ${p.cls} → ${saved.file} (${saved.bytes} bytes)`);
        } else if (p && p.type === "catalog-dump" && p.name && Array.isArray(p.items)) {
            const saved = persistence.saveCatalog(p.name, p.items);
            console.log(`[dofus] persisted catalog '${p.name}' (${saved.count} entries, ${saved.bytes} bytes)`);
        } else if (p && p.type === "map-cache" && p.mapId && p.data) {
            const saved = persistence.saveMapData(p.mapId, p.data);
            console.log(`[dofus] cached map ${p.mapId} → ${saved.file} (${saved.bytes} bytes)`);
        } else if (p && p.type === "cartography-tile" && typeof p.worldMapId === "number" && data) {
            const saved = persistence.saveCartographyTile(p.worldMapId, p.tileIndex, Buffer.from(data), p.format || "jpg");
            if (p.tileIndex === 0 || p.tileIndex % 20 === 0) {
                console.log(`[dofus] cartography wm=${p.worldMapId} tile ${p.tileIndex} → ${saved.file} (${saved.bytes} bytes)`);
            }
        }
    } catch (e) { console.error("[dofus] persistence failed:", e); }
    broadcast({ type: "message", message: m });
});

// -------- static file serving (own public + tile assets) --------------------
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".jpg":  "image/jpeg",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
};

function serveFile(res, file) {
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
    });
}

// Toolkit's `host/public/` is reused for shared shell assets (theme.css,
// fonts, dist/lib/*) so we don't have to duplicate them.
const TOOLKIT_PUBLIC = path.resolve(__dirname, "..", "host", "public");

async function serveStatic(req, res, pathname) {
    // /tiles/<file>.jpg → bundle-extracted cartography tile
    const tile = pathname.match(/^\/tiles\/(\d+_\S+\.(?:jpg|png))$/i);
    if (tile) {
        return serveFile(res, persistence.bundleTilePath(tile[1]));
    }

    const rel = pathname === "/" ? "/index.html" : pathname;
    // Try dofus-app/public first, fall back to toolkit public for shared
    // assets (theme.css, lib/, dist/lib/, fonts/).
    const own = path.join(PUBLIC_DIR, rel);
    if (own.startsWith(PUBLIC_DIR) && fs.existsSync(own)) return serveFile(res, own);
    const fallback = path.join(TOOLKIT_PUBLIC, rel);
    if (fallback.startsWith(TOOLKIT_PUBLIC) && fs.existsSync(fallback)) return serveFile(res, fallback);
    res.writeHead(404); res.end("not found");
}

// -------- route table -------------------------------------------------------
const routes = {
    GET: {
        "/api/processes": async (req, res, q) => sendJson(res, 200, await bridge.listProcesses(q.q)),
        "/api/status":    (req, res)           => sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() }),
        "/api/maps":      (_req, res)          => sendJson(res, 200, persistence.listCachedMaps()),
        "/api/catalog":   (_req, res)          => sendJson(res, 200, persistence.listCatalogs()),
        "/api/coverage-plan": (_req, res) => {
            const plan = persistence.readCoveragePlan();
            if (!plan) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, plan);
        },
        "/api/gfx-to-type": (_req, res) => sendJson(res, 200, persistence.readGfxRegistry()),
        "/api/wm-tile-names": (_req, res) => sendJson(res, 200, persistence.listWmTileNames()),
        "/api/tile-mapping": (_req, res) => {
            const m = persistence.readTileMapping();
            if (!m) { sendJson(res, 200, null); return; }
            sendJson(res, 200, m);
        },
    },
    GET_param: {
        "/api/maps": (_req, res, _q, mapId) => {
            const m = persistence.readMapData(mapId);
            if (!m) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, m);
        },
        "/api/catalog": (_req, res, _q, slug) => {
            const c = persistence.readCatalog(slug);
            if (!c) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, c);
        },
    },
    POST: {
        "/api/attach": async (req, res) => {
            const { pid } = JSON.parse(await readBody(req));
            sendJson(res, 200, await bridge.attach(pid));
        },
        "/api/detach": async (req, res) => { await bridge.detach(); sendJson(res, 200, { ok: true }); },
        "/api/reload": async (req, res) => {
            const info = bridge.getAttachedInfo();
            if (!info) throw new Error("not attached");
            sendJson(res, 200, await bridge.attach(info.pid));
        },
        "/api/call": async (req, res) => {
            const { method, args } = JSON.parse(await readBody(req));
            const result = await bridge.callRpc(method, args || []);
            sendJson(res, 200, { result });
        },
        "/api/build-tile-mapping": (_req, res) => {
            const script = path.join(__dirname, "scripts", "build-tile-mapping.py");
            const proc = spawn("python", [script], { cwd: __dirname });
            let stdout = "", stderr = "";
            proc.stdout.on("data", d => stdout += d);
            proc.stderr.on("data", d => stderr += d);
            proc.on("close", code => sendJson(res, 200, { code, stdout, stderr }));
            proc.on("error", err => sendJson(res, 500, { error: String(err) }));
        },
        "/api/addressables": async (req, res) => {
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.saveAddressables(body));
        },
    },
    POST_param: {
        "/api/maps": async (req, res, _q, mapId) => {
            const id = parseInt(String(mapId), 10);
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.saveMapData(id, body));
        },
        "/api/wm-tile-names": async (req, res, _q, wmId) => {
            const id = parseInt(String(wmId), 10);
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.saveWmTileNames(id, body.tiles || []));
        },
    },
};

const fallback = (req, res, pathname) => serveStatic(req, res, pathname);

// -------- server boot -------------------------------------------------------
const server = http.createServer(makeHandler(routes, fallback));
wsModule.attach(server, () => ({ type: "hello", attached: bridge.getAttachedInfo() }));

server.listen(PORT, () => {
    console.log(`[dofus] Dofus app UI → http://localhost:${PORT}`);
    const AGENT_PATH = path.resolve(__dirname, "..", "build", "rpc-agent.js");
    console.log(`[dofus] agent path: ${AGENT_PATH}`);
});

async function shutdown() {
    console.log("\n[dofus] shutting down…");
    try { await bridge.detach(); } catch {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
