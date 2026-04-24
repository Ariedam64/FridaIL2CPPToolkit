#!/usr/bin/env node
/* =============================================================================
 * Frida IL2CPP Toolkit — local HTTP + WebSocket host
 * =============================================================================
 * Run:   npm run host
 * Open:  http://localhost:3000
 * =============================================================================
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");

const bridge                      = require("./lib/frida-bridge");
const wsModule                    = require("./lib/ws");
const { makeHandler, sendJson, readBody } = require("./lib/router");
const persistence                 = require("./lib/persistence");
const { broadcast }               = wsModule;

const PORT       = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------- wire bridge events ------------------------------------------------
bridge.on("attached", (info) => broadcast({ type: "attached", ...info }));
bridge.on("detached", (e) => broadcast({ type: "detached", reason: e.reason }));
bridge.on("message", (m) => broadcast({ type: "message", message: m }));

// -------- static file serving -----------------------------------------------
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
};

async function serveStatic(req, res, pathname) {
    const rel  = pathname === "/" ? "/index.html" : pathname;
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403); res.end("forbidden"); return;
    }
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
    });
}

// -------- route table -------------------------------------------------------
const routes = {
    GET: {
        "/api/processes":  async (req, res, q) => sendJson(res, 200, await bridge.listProcesses(q.q)),
        "/api/status":     (req, res)           => sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() }),
        "/api/bookmarks":  (_req, res)          => sendJson(res, 200, persistence.listBookmarks()),
        "/api/presets":    (_req, res)          => sendJson(res, 200, persistence.listPresets()),
        "/api/presets/auto": (_req, res, _q) => {
            const info = bridge.getAttachedInfo();
            if (!info) { sendJson(res, 200, null); return; }
            sendJson(res, 200, persistence.getPresetForProcess(info.name));
        },
    },
    GET_param: {
        "/api/bookmarks": (_req, res, _q, slug) => {
            const bm = persistence.getBookmark(slug);
            if (!bm) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, bm);
        },
        "/api/presets": (_req, res, _q, slug) => {
            const p = persistence.getPreset(slug);
            if (!p) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, p);
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
        "/api/dumps": async (req, res) => {
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.saveDump(body.content || "", body.meta || {}));
        },
    },
    POST_param: {
        "/api/bookmarks": async (req, res, _q, slug) => {
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.saveBookmark(body.name || slug, body));
        },
        "/api/presets": async (req, res, _q, slug) => {
            const body = JSON.parse(await readBody(req));
            sendJson(res, 200, persistence.savePreset(slug, body));
        },
    },
    DELETE_param: {
        "/api/bookmarks": (_req, res, _q, slug) => {
            sendJson(res, 200, { deleted: persistence.deleteBookmark(slug) });
        },
    },
};

const fallback = (req, res, pathname) => serveStatic(req, res, pathname);

// -------- server boot -------------------------------------------------------
const server = http.createServer(makeHandler(routes, fallback));
wsModule.attach(server, () => ({ type: "hello", attached: bridge.getAttachedInfo() }));

server.listen(PORT, () => {
    console.log(`[host] Frida IL2CPP Toolkit UI → http://localhost:${PORT}`);
    const AGENT_PATH = path.resolve(__dirname, "..", "build", "rpc-agent.js");
    console.log(`[host] agent path: ${AGENT_PATH}`);
});

async function shutdown() {
    console.log("\n[host] shutting down…");
    try { await bridge.detach(); } catch {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
