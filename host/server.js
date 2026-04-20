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
const { WebSocketServer } = require("ws");

let frida;  // loaded lazily — the npm package is ESM-only

const PORT       = parseInt(process.env.PORT || "3000", 10);
const AGENT_PATH = path.resolve(__dirname, "..", "build", "rpc-agent.js");
const PUBLIC_DIR = path.join(__dirname, "public");

async function getFrida() {
    if (!frida) frida = await import("frida");
    return frida;
}

let session        = null;
let script         = null;
let attachedInfo   = null;   // { pid, name }
const wsClients    = new Set();

// -------- broadcast ---------------------------------------------------------
function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
        if (ws.readyState === 1) ws.send(data);
    }
}

// -------- Frida attach / detach / call --------------------------------------
async function attach(pid) {
    await detach();
    if (!fs.existsSync(AGENT_PATH)) {
        throw new Error(`agent not built: ${AGENT_PATH}. Run: npm run build:rpc`);
    }
    const f = await getFrida();
    const device = await f.getLocalDevice();
    const procs  = await device.enumerateProcesses();
    const proc   = procs.find(p => p.pid === pid);
    if (!proc) throw new Error(`PID ${pid} not found`);

    session = await device.attach(pid);
    session.detached.connect((reason) => {
        broadcast({ type: "detached", reason });
        attachedInfo = null;
        session = null;
        script = null;
    });

    const source = fs.readFileSync(AGENT_PATH, "utf8");
    script = await session.createScript(source);
    script.message.connect((message) => {
        broadcast({ type: "message", message });
    });
    // Frida v17 routes console.log output to script.logHandler (it's intercepted
    // before reaching the `message` signal). Override so logs flow over WS too.
    script.logHandler = (level, payload) => {
        broadcast({ type: "message", message: { type: "log", level, payload } });
    };
    await script.load();

    attachedInfo = { pid, name: proc.name };
    broadcast({ type: "attached", ...attachedInfo });
    return attachedInfo;
}

async function detach() {
    if (script) {
        try { await script.unload(); } catch {}
        script = null;
    }
    if (session) {
        try { await session.detach(); } catch {}
        session = null;
    }
    if (attachedInfo) {
        broadcast({ type: "detached" });
        attachedInfo = null;
    }
}

async function callRpc(method, args = []) {
    if (!script) throw new Error("not attached");
    const api = script.exports;
    if (typeof api[method] !== "function") {
        throw new Error(`unknown RPC method: ${method}`);
    }
    return await api[method](...args);
}

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
            const f = await getFrida();
            const device = await f.getLocalDevice();
            const procs  = await device.enumerateProcesses();
            const q      = String(parsed.query.q || "").toLowerCase();
            const filtered = q ? procs.filter(p => p.name.toLowerCase().includes(q)) : procs;
            filtered.sort((a, b) => a.name.localeCompare(b.name));
            return sendJson(res, 200, filtered.map(p => ({ pid: p.pid, name: p.name })));
        }
        if (req.method === "GET" && parsed.pathname === "/api/status") {
            return sendJson(res, 200, { attached: !!attachedInfo, info: attachedInfo });
        }
        if (req.method === "POST" && parsed.pathname === "/api/attach") {
            const body = await readBody(req);
            const { pid } = JSON.parse(body);
            const info = await attach(pid);
            return sendJson(res, 200, info);
        }
        if (req.method === "POST" && parsed.pathname === "/api/detach") {
            await detach();
            return sendJson(res, 200, { ok: true });
        }
        if (req.method === "POST" && parsed.pathname === "/api/reload") {
            if (!attachedInfo) throw new Error("not attached");
            const pid = attachedInfo.pid;
            const info = await attach(pid);
            return sendJson(res, 200, info);
        }
        if (req.method === "POST" && parsed.pathname === "/api/call") {
            const body = await readBody(req);
            const { method, args } = JSON.parse(body);
            const result = await callRpc(method, args || []);
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
const wss    = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify({ type: "hello", attached: attachedInfo }));
    ws.on("close", () => wsClients.delete(ws));
});

server.listen(PORT, () => {
    console.log(`[host] Frida IL2CPP Toolkit UI → http://localhost:${PORT}`);
    console.log(`[host] agent path: ${AGENT_PATH}`);
});

async function shutdown() {
    console.log("\n[host] shutting down…");
    try { await detach(); } catch {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
