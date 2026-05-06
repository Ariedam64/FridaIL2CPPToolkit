// app/backend/frida-client.ts
//
// Wraps frida-node into a Node-pure RPC client. Same surface as the
// old vscode-coupled FridaDirectClient — call(method, args), isHealthy(),
// listProcesses(), attach(pid), detach() — but emits via EventEmitter
// from node:events instead of vscode.EventEmitter.

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as frida from "frida";

export interface ProcessInfo {
    pid: number;
    name: string;
}

export interface AttachInfo {
    pid: number;
    name: string;
}

export class FridaClient extends EventEmitter {
    private session: frida.Session | null = null;
    private script: frida.Script | null = null;
    private currentPid: number | null = null;
    private attachAborted = false;
    private forwardHandler: ((msg: frida.Message) => void) | null = null;

    constructor(private readonly agentScriptPath: string) {
        super();
    }

    async listProcesses(): Promise<ProcessInfo[]> {
        const dev = await frida.getLocalDevice();
        const processes = await dev.enumerateProcesses();
        return processes.map((p) => ({ pid: p.pid, name: p.name }));
    }

    async attach(pid: number): Promise<AttachInfo> {
        if (this.session) {
            await this.detach();
        }
        this.attachAborted = false;
        const dev = await frida.getLocalDevice();
        const session = await dev.attach(pid);
        const source = fs.readFileSync(this.agentScriptPath, "utf-8");
        const script = await session.createScript(source);

        // Wait for agent-ready before resolving so the first /api/call works.
        const ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error("agent-ready timeout (10s)")),
                10_000,
            );
            const onMessage = (msg: frida.Message): void => {
                if (
                    msg.type === frida.MessageType.Send &&
                    msg.payload?.type === "agent-ready"
                ) {
                    clearTimeout(timer);
                    script.message.disconnect(onMessage);
                    resolve();
                }
            };
            script.message.connect(onMessage);
        });

        await script.load();
        await ready;

        if (this.attachAborted) {
            try { await script.unload(); } catch {}
            try { await session.detach(); } catch {}
            throw new Error("attach aborted");
        }

        // Forward all subsequent send() payloads as "agent-message" events.
        this.forwardHandler = (msg: frida.Message) => {
            if (msg.type === frida.MessageType.Send && msg.payload !== undefined) {
                this.emit("agent-message", msg.payload);
            }
        };
        script.message.connect(this.forwardHandler);

        const procName = await this.findProcessName(pid);
        this.session = session;
        this.script = script;
        this.currentPid = pid;
        this.emit("attached", { pid, name: procName });
        return { pid, name: procName };
    }

    async detach(): Promise<void> {
        this.attachAborted = true;
        if (this.script && this.forwardHandler) {
            try { this.script.message.disconnect(this.forwardHandler); } catch {}
        }
        this.forwardHandler = null;
        try { await this.script?.unload(); } catch { /* ignore */ }
        try { await this.session?.detach(); } catch { /* ignore */ }
        this.script = null;
        this.session = null;
        this.currentPid = null;
        this.emit("detached");
    }

    isAttached(): boolean {
        return this.session !== null && this.script !== null;
    }

    currentProcess(): number | null {
        return this.currentPid;
    }

    async isHealthy(): Promise<boolean> {
        if (!this.script || this.script.isDestroyed) return false;
        return true;
    }

    async call<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
        if (!this.script) throw new Error("not attached");
        const exp = this.script.exports[method];
        if (typeof exp !== "function") throw new Error(`unknown rpc method: ${method}`);
        return (await exp(...args)) as T;
    }

    private async findProcessName(pid: number): Promise<string> {
        try {
            const dev = await frida.getLocalDevice();
            const procs = await dev.enumerateProcesses();
            return procs.find((p) => p.pid === pid)?.name ?? `pid-${pid}`;
        } catch {
            return `pid-${pid}`;
        }
    }
}
