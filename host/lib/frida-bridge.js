/* Thin wrapper around the Frida node API: attach/detach/call RPC. */
const fs = require("fs");
const path = require("path");

let frida;
async function getFrida() {
    if (!frida) frida = await import("frida");
    return frida;
}

const AGENT_PATH = path.resolve(__dirname, "..", "..", "build", "rpc-agent.js");

let session = null;
let script = null;
let attachedInfo = null;
const listeners = { attached: [], detached: [], message: [] };

function on(event, cb) { listeners[event].push(cb); }
function emit(event, ...args) { for (const cb of listeners[event]) cb(...args); }

async function attach(pid) {
    await detach();
    if (!fs.existsSync(AGENT_PATH)) {
        throw new Error(`agent not built: ${AGENT_PATH}. Run: npm run build:rpc`);
    }
    const f = await getFrida();
    const device = await f.getLocalDevice();
    const procs = await device.enumerateProcesses();
    const proc = procs.find(p => p.pid === pid);
    if (!proc) throw new Error(`PID ${pid} not found`);

    session = await device.attach(pid);
    session.detached.connect((reason) => {
        emit("detached", { reason });
        attachedInfo = null; session = null; script = null;
    });

    const source = fs.readFileSync(AGENT_PATH, "utf8");
    script = await session.createScript(source);
    script.message.connect((message, data) => emit("message", message, data));
    script.logHandler = (level, payload) => emit("message", { type: "log", level, payload });
    await script.load();

    attachedInfo = { pid, name: proc.name };
    emit("attached", attachedInfo);
    return attachedInfo;
}

async function detach() {
    if (script) { try { await script.unload(); } catch {} script = null; }
    if (session) { try { await session.detach(); } catch {} session = null; }
    if (attachedInfo) { emit("detached", {}); attachedInfo = null; }
}

async function callRpc(method, args = []) {
    if (!script) throw new Error("not attached");
    const api = script.exports;
    if (typeof api[method] !== "function") {
        throw new Error(`unknown RPC method: ${method}`);
    }
    return await api[method](...args);
}

async function listProcesses(query) {
    const f = await getFrida();
    const device = await f.getLocalDevice();
    const procs = await device.enumerateProcesses();
    const q = String(query || "").toLowerCase();
    const filtered = q ? procs.filter(p => p.name.toLowerCase().includes(q)) : procs;
    filtered.sort((a, b) => a.name.localeCompare(b.name));
    return filtered.map(p => ({ pid: p.pid, name: p.name }));
}

function getAttachedInfo() { return attachedInfo; }

module.exports = { attach, detach, callRpc, listProcesses, getAttachedInfo, on };
