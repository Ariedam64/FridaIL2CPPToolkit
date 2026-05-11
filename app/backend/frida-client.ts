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

    /** Spawn an executable in a SUSPENDED state and return its pid. Call
     *  attach(pid) to load the agent, then resume(pid) to let it run. */
    async spawn(exePath: string): Promise<number> {
        const dev = await frida.getLocalDevice();
        return await dev.spawn(exePath);
    }

    /** Resume a previously spawn()-ed pid. No-op if the process is already running. */
    async resume(pid: number): Promise<void> {
        const dev = await frida.getLocalDevice();
        await dev.resume(pid);
    }

    /** Enable system-wide spawn gating: every new process the OS spawns is
     *  paused immediately, before its main() runs. Use waitForSpawn() to
     *  catch a specific identifier, then call resume() once attached.
     *  Non-matching spawns must be resumed promptly to avoid wedging the OS. */
    async enableSpawnGating(): Promise<void> {
        const dev = await frida.getLocalDevice();
        await dev.enableSpawnGating();
    }

    async disableSpawnGating(): Promise<void> {
        const dev = await frida.getLocalDevice();
        await dev.disableSpawnGating();
    }

    /** Listen for the next process whose identifier (path/name) includes
     *  `identifierSubstring` (case-insensitive). All other gated spawns are
     *  auto-resumed so the OS doesn't wedge. Returns the matched pid, or
     *  null on timeout. */
    async waitForSpawn(identifierSubstring: string, timeoutMs: number): Promise<{ pid: number; identifier: string } | null> {
        const needle = identifierSubstring.toLowerCase();
        const dev = await frida.getLocalDevice();
        return new Promise((resolve) => {
            let done = false;
            const finish = (v: { pid: number; identifier: string } | null): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                try { dev.spawnAdded.disconnect(onSpawn); } catch {}
                resolve(v);
            };
            const onSpawn = (spawn: frida.Spawn): void => {
                const id = spawn.identifier ?? "";
                if (id.toLowerCase().includes(needle)) {
                    finish({ pid: spawn.pid, identifier: id });
                } else {
                    // Not our target — let it run so we don't freeze unrelated apps.
                    dev.resume(spawn.pid).catch(() => { /* best-effort */ });
                }
            };
            dev.spawnAdded.connect(onSpawn);
            const timer = setTimeout(() => finish(null), timeoutMs);
        });
    }

    /** Attach to a running process, load the agent, and wait for the agent
     *  to report ready. For SUSPENDED (spawn'd) processes pass
     *  `{ suspended: true }`: load completes but agent-ready won't fire until
     *  the caller resumes; do that with `resume(pid)` then `waitForAgentReady()`. */
    async attach(pid: number, opts: { suspended?: boolean } = {}): Promise<AttachInfo> {
        if (this.session) {
            await this.detach();
        }
        this.attachAborted = false;
        const dev = await frida.getLocalDevice();
        const session = await dev.attach(pid);
        const source = fs.readFileSync(this.agentScriptPath, "utf-8");
        const script = await session.createScript(source);

        // Wire the ready-wait BEFORE load() so we don't miss the send().
        this.readyPromise = this.waitForAgentReadyOn(script, opts.suspended ? Number.POSITIVE_INFINITY : 10_000);

        await script.load();
        if (!opts.suspended) {
            await this.readyPromise;
        }

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
        if (!opts.suspended) this.emit("attached", { pid, name: procName });
        return { pid, name: procName };
    }

    private readyPromise: Promise<void> | null = null;

    /** Await the agent-ready signal. For a normal attach this is already done
     *  by attach() itself; for a suspended-mode attach the caller invokes this
     *  after resume(pid). Returns immediately if ready was already signaled. */
    async waitForAgentReady(): Promise<void> {
        if (!this.readyPromise) throw new Error("not attached");
        await this.readyPromise;
        // Fire the 'attached' event now that the agent is actually usable.
        // Suspended-mode attach skipped emitting it earlier.
        if (this.currentPid !== null && this.session && this.script) {
            const procName = await this.findProcessName(this.currentPid);
            this.emit("attached", { pid: this.currentPid, name: procName });
        }
    }

    private waitForAgentReadyOn(script: frida.Script, timeoutMs: number): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const timer = Number.isFinite(timeoutMs)
                ? setTimeout(() => reject(new Error(`agent-ready timeout (${timeoutMs}ms)`)), timeoutMs)
                : null;
            const onMessage = (msg: frida.Message): void => {
                if (
                    msg.type === frida.MessageType.Send &&
                    msg.payload?.type === "agent-ready"
                ) {
                    if (timer) clearTimeout(timer);
                    script.message.disconnect(onMessage);
                    resolve();
                }
            };
            script.message.connect(onMessage);
        });
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
        this.readyPromise = null;
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

    /** Send a `pre-arm-config` message to the agent script and wait for
     *  its acknowledgement. Used by the freeze-and-attach path so the
     *  agent installs the network hooks INSIDE its first Il2Cpp.perform —
     *  before agent-ready, before the game has had a chance to send anything.
     *  Must be called while the target process is still suspended. */
    async postPreArmConfig(config: unknown, timeoutMs = 5_000): Promise<void> {
        await this.postAndWaitAck("pre-arm-config", { type: "pre-arm-config", config }, "pre-arm-ack", timeoutMs);
    }

    /** Send a `pre-arm-methods` message to install arbitrary method hooks
     *  before agent-ready. Each spec is { className, methodName, ns? }.
     *  Captures are accessible via the agent's `getPreArmCaptures` RPC. */
    async postPreArmMethods(hooks: Array<{ className: string; methodName: string; ns?: string }>, timeoutMs = 5_000): Promise<void> {
        await this.postAndWaitAck("pre-arm-methods", { type: "pre-arm-methods", hooks }, "pre-arm-methods-ack", timeoutMs);
    }

    private async postAndWaitAck(label: string, payload: unknown, ackType: string, timeoutMs: number): Promise<void> {
        if (!this.script) throw new Error("not attached");
        const script = this.script;
        const ackP = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                script.message.disconnect(onMessage);
                reject(new Error(`${label} ack timeout (${timeoutMs}ms)`));
            }, timeoutMs);
            const onMessage = (msg: frida.Message): void => {
                if (
                    msg.type === frida.MessageType.Send &&
                    (msg.payload as any)?.type === ackType
                ) {
                    clearTimeout(timer);
                    script.message.disconnect(onMessage);
                    resolve();
                }
            };
            script.message.connect(onMessage);
        });
        script.post(payload);
        await ackP;
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
