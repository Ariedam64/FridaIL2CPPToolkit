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
const url  = require("url");

const bridge    = require("./lib/frida-bridge");
const wsModule  = require("./lib/ws");
const { broadcast } = wsModule;

const PORT       = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------- wire bridge events ------------------------------------------------
bridge.on("attached", (info) => broadcast({ type: "attached", ...info }));
bridge.on("detached", (e) => broadcast({ type: "detached", reason: e.reason }));
bridge.on("message",  (m) => broadcast({ type: "message", message: m }));

// -------- HTTP --------------------------------------------------------------
function sendJson(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", c => data += c);
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
}

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

async function handleRequest(req, res) {
    const parsed = url.parse(req.url, true);
    try {
        if (req.method === "GET" && parsed.pathname === "/api/processes") {
            return sendJson(res, 200, await bridge.listProcesses(parsed.query.q));
        }
        if (req.method === "GET" && parsed.pathname === "/api/status") {
            return sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() });
        }
        if (req.method === "POST" && parsed.pathname === "/api/attach") {
            const body = await readBody(req);
            const { pid } = JSON.parse(body);
            const info = await bridge.attach(pid);
            return sendJson(res, 200, info);
        }
        if (req.method === "POST" && parsed.pathname === "/api/detach") {
            await bridge.detach();
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && parsed.pathname === "/api/reload") {
            if (!bridge.getAttachedInfo()) throw new Error("not attached");
            const pid = bridge.getAttachedInfo().pid;
            const info = await bridge.attach(pid);
            return sendJson(res, 200, info);
        }
        if (req.method === "POST" && parsed.pathname === "/api/call") {
            const body = await readBody(req);
            const { method, args } = JSON.parse(body);
            const result = await bridge.callRpc(method, args || []);
            return sendJson(res, 200, { result });
        }
        return serveStatic(req, res, parsed.pathname);
    } catch (e) {
        console.error("[http]", e);
        sendJson(res, 500, { error: String(e.message || e) });
    }
}

// -------- server boot -------------------------------------------------------
const server = http.createServer(handleRequest);
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
