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

import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import type { RpcClient } from "./types";

// frida is a native module loaded via dynamic require so the rest of the
// extension can be unit-tested without it.
type FridaModule = {
    getLocalDevice(): Promise<FridaDevice>;
};
type FridaDevice = {
    enumerateProcesses(): Promise<Array<{ pid: number; name: string }>>;
    attach(pid: number): Promise<FridaSession>;
};
type FridaSession = {
    detach(): Promise<void>;
    detached: { connect(cb: (reason: string) => void): void };
    createScript(source: string): Promise<FridaScript>;
};
type FridaScript = {
    load(): Promise<void>;
    unload(): Promise<void>;
    exports: Record<string, (...args: unknown[]) => Promise<unknown>>;
    message: { connect(cb: (msg: unknown, data: Buffer | null) => void): void };
    logHandler?: (level: string, payload: string) => void;
};

export interface AttachInfo {
    pid: number;
    name: string;
}

export class FridaDirectClient implements RpcClient {
    private session: FridaSession | null = null;
    private script: FridaScript | null = null;
    private attachedInfo: AttachInfo | null = null;
    private readonly listeners: Array<(info: AttachInfo | null) => void> = [];
    private fridaCache: FridaModule | null = null;

    constructor(private readonly agentScriptPath: string) {}

    private async getFrida(): Promise<FridaModule> {
        if (this.fridaCache) return this.fridaCache;
        // require() at runtime, lazy — frida is a native module that may
        // not be installed in test environments.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        this.fridaCache = require("frida") as FridaModule;
        return this.fridaCache;
    }

    onAttachChange(cb: (info: AttachInfo | null) => void): () => void {
        this.listeners.push(cb);
        return () => {
            const i = this.listeners.indexOf(cb);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emitChange(): void {
        for (const cb of this.listeners) {
            try { cb(this.attachedInfo); } catch { /* ignore */ }
        }
    }

    getAttachedInfo(): AttachInfo | null {
        return this.attachedInfo;
    }

    async listProcesses(filter?: string): Promise<AttachInfo[]> {
        const frida = await this.getFrida();
        const device = await frida.getLocalDevice();
        const procs = await device.enumerateProcesses();
        const q = (filter ?? "").toLowerCase();
        const filtered = q ? procs.filter((p) => p.name.toLowerCase().includes(q)) : procs;
        filtered.sort((a, b) => a.name.localeCompare(b.name));
        return filtered.map((p) => ({ pid: p.pid, name: p.name }));
    }

    async attach(pid: number): Promise<AttachInfo> {
        await this.detach();

        if (!fs.existsSync(this.agentScriptPath)) {
            throw new Error(
                `Agent script not built: ${this.agentScriptPath}\n` +
                `Run from the repo root: npm run build:rpc`,
            );
        }

        const frida = await this.getFrida();
        const device = await frida.getLocalDevice();
        const procs = await device.enumerateProcesses();
        const proc = procs.find((p) => p.pid === pid);
        if (!proc) throw new Error(`PID ${pid} not found`);

        this.session = await device.attach(pid);
        this.session.detached.connect((reason: string) => {
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
        let resolveReady: (() => void) | null = null;
        const agentReady = new Promise<void>((resolve) => { resolveReady = resolve; });

        this.script.message.connect((msg: unknown) => {
            if (msg && typeof msg === "object") {
                const m = msg as { type?: string; payload?: { type?: string } };
                if (m.type === "send" && m.payload?.type === "agent-ready") {
                    console.log("[frida-direct] agent-ready received");
                    resolveReady?.();
                }
                if (m.type === "error") {
                    console.error("[frida-direct] agent error:", msg);
                }
            }
        });
        this.script.logHandler = (level: string, payload: string) => {
            console.log(`[frida-agent ${level}]`, payload);
        };
        await this.script.load();

        // Wait up to 10s for the agent to signal ready. If we time out,
        // proceed anyway — IL2CPP may already be initialized in the host.
        await Promise.race([
            agentReady,
            new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
        ]);

        this.attachedInfo = { pid, name: proc.name };
        this.emitChange();
        return this.attachedInfo;
    }

    async detach(): Promise<void> {
        if (this.script) {
            try { await this.script.unload(); } catch { /* ignore */ }
            this.script = null;
        }
        if (this.session) {
            try { await this.session.detach(); } catch { /* ignore */ }
            this.session = null;
        }
        if (this.attachedInfo) {
            this.attachedInfo = null;
            this.emitChange();
        }
    }

    async call<T>(method: string, args: unknown[] = []): Promise<T> {
        if (!this.script) {
            throw new Error("not attached — use Frida: Attach to process first");
        }
        const fn = this.script.exports[method];
        if (typeof fn !== "function") {
            throw new Error(`unknown RPC method: ${method}`);
        }
        return (await fn(...args)) as T;
    }

    async isHealthy(): Promise<boolean> {
        if (!this.script) return false;
        try {
            await this.call<unknown[]>("listAssembliesInfo", []);
            return true;
        } catch {
            return false;
        }
    }
}

/** Resolve the default agent script path relative to the extension location. */
export function resolveDefaultAgentPath(extension: vscode.Extension<unknown> | undefined): string {
    const extPath = extension?.extensionPath ?? __dirname;
    // Extension lives at <repo>/dofus-app/vscode-extension/
    // Compiled agent is at <repo>/build/rpc-agent.js
    return path.resolve(extPath, "..", "..", "build", "rpc-agent.js");
}
