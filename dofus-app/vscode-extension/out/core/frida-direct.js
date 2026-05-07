"use strict";
// FridaDirectClient — talks to a local Frida device directly via the
// `frida` Node binding. No HTTP server needed.
//
// Lifecycle:
//   - listProcesses() : ask user to pick a target via Quick Pick
//   - attach(pid)     : spawn session, load compiled agent script
//   - call(method,args): forward to script.exports[method]
//   - detach()        : unload script + close session
//
// The agent script must be pre-built with `npm run build:rpc` in the
// repository root. Path is resolved via the extension setting
// fridaToolkit.agentScriptPath (default: <extension>/../../build/rpc-agent.js).
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FridaDirectClient = void 0;
exports.resolveDefaultAgentPath = resolveDefaultAgentPath;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class FridaDirectClient {
    agentScriptPath;
    session = null;
    script = null;
    attachedInfo = null;
    listeners = [];
    fridaCache = null;
    _onMessage = new vscode.EventEmitter();
    /** Stream of `send()` payloads from the agent (after `type === "send"` filter). */
    onMessage = this._onMessage.event;
    constructor(agentScriptPath) {
        this.agentScriptPath = agentScriptPath;
    }
    async getFrida() {
        if (this.fridaCache)
            return this.fridaCache;
        // require() at runtime, lazy — frida is a native module that may
        // not be installed in test environments.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this.fridaCache = require("frida");
        return this.fridaCache;
    }
    onAttachChange(cb) {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0)
                this.listeners.splice(i, 1);
        };
    }
    emitChange() {
        for (const cb of this.listeners) {
            try {
                cb(this.attachedInfo);
            }
            catch { /* ignore */ }
        }
    }
    getAttachedInfo() {
        return this.attachedInfo;
    }
    async listProcesses(filter) {
        const frida = await this.getFrida();
        const device = await frida.getLocalDevice();
        const procs = await device.enumerateProcesses();
        const q = (filter ?? "").toLowerCase();
        const filtered = q ? procs.filter((p) => p.name.toLowerCase().includes(q)) : procs;
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        return filtered.map((p) => ({ pid: p.pid, name: p.name }));
    }
    async attach(pid) {
        await this.detach();
        if (!fs.existsSync(this.agentScriptPath)) {
            throw new Error(`Agent script not built: ${this.agentScriptPath}\n` +
                `Run from the repo root: npm run build:rpc`);
        }
        const frida = await this.getFrida();
        const device = await frida.getLocalDevice();
        const procs = await device.enumerateProcesses();
        const proc = procs.find((p) => p.pid === pid);
        if (!proc)
            throw new Error(`PID ${pid} not found`);
        this.session = await device.attach(pid);
        this.session.detached.connect((reason) => {
            console.warn(`[frida-direct] detached (reason=${reason})`);
            this.attachedInfo = null;
            this.session = null;
            this.script = null;
            this.emitChange();
        });
        const source = fs.readFileSync(this.agentScriptPath, "utf-8");
        this.script = await this.session.createScript(source);
        // The agent calls `send({type:"agent-ready"})` after Il2Cpp.perform()
        // has finished initializing. Until then, RPC methods that touch IL2CPP
        // will fail. We listen for that message and resolve `agentReady` to
        // gate the rest of init.
        let resolveReady = null;
        const agentReady = new Promise((resolve) => { resolveReady = resolve; });
        this.script.message.connect((msg) => {
            if (msg && typeof msg === "object") {
                const m = msg;
                if (m.type === "send" && m.payload?.type === "agent-ready") {
                    console.log("[frida-direct] agent-ready received");
                    resolveReady?.();
                }
                if (m.type === "send" && m.payload !== undefined) {
                    this._onMessage.fire(m.payload);
                }
                if (m.type === "error") {
                    console.error("[frida-direct] agent error:", msg);
                }
            }
        });
        this.script.logHandler = (level, payload) => {
            console.log(`[frida-agent ${level}]`, payload);
        };
        await this.script.load();
        // Wait up to 10s for the agent to signal ready. If we time out,
        // proceed anyway — IL2CPP may already be initialized in the host.
        await Promise.race([
            agentReady,
            new Promise((resolve) => setTimeout(resolve, 10_000)),
        ]);
        this.attachedInfo = { pid, name: proc.name };
        this.emitChange();
        return this.attachedInfo;
    }
    async detach() {
        if (this.script) {
            try {
                await this.script.unload();
            }
            catch { /* ignore */ }
            this.script = null;
        }
        if (this.session) {
            try {
                await this.session.detach();
            }
            catch { /* ignore */ }
            this.session = null;
        }
        if (this.attachedInfo) {
            this.attachedInfo = null;
            this.emitChange();
        }
    }
    dispose() {
        this._onMessage.dispose();
    }
    async call(method, args = []) {
        if (!this.script) {
            throw new Error("not attached — use Frida: Attach to process first");
        }
        const fn = this.script.exports[method];
        if (typeof fn !== "function") {
            throw new Error(`unknown RPC method: ${method}`);
        }
        return (await fn(...args));
    }
    async isHealthy() {
        if (!this.script)
            return false;
        try {
            await this.call("listAssembliesInfo", []);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.FridaDirectClient = FridaDirectClient;
/** Resolve the default agent script path relative to the extension location. */
function resolveDefaultAgentPath(extension) {
    const extPath = extension?.extensionPath ?? __dirname;
    // Extension lives at <repo>/dofus-app/vscode-extension/
    // Compiled agent is at <repo>/build/rpc-agent.js
    return path.resolve(extPath, "..", "..", "build", "rpc-agent.js");
}
//# sourceMappingURL=frida-direct.js.map