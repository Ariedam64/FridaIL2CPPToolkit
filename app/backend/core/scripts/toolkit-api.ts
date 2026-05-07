import type { InstanceRegistry } from "../instances/instance-registry";
import type { HookStore } from "../hooks/hook-store";
import type { FrameStore } from "../network/frame-store";
import type {
    Toolkit, InstanceHandle, HookHandle, NetworkPacket, CaptureOpts,
    HookInstallOpts, HookCallEvent, ScriptLog,
} from "./types";
import type { HookSpec } from "../hooks/types";
import type { NetworkFrame } from "../network/types";

export interface ToolkitDeps {
    runId: string;
    instanceRegistry: InstanceRegistry | null;
    hookStore: HookStore | null;
    frameStore: FrameStore | null;
    agentCall: (method: string, args: unknown[]) => Promise<unknown>;
    resolveLabel: (friendly: string) => string;   // friendly → obf via LabelStore (or identity)
    emitLog: (log: Omit<ScriptLog, "runId" | "ts">) => void;
}

export function buildToolkit(deps: ToolkitDeps): Toolkit {
    return {
        instances: buildInstances(deps),
        hooks:     buildHooks(deps),      // T6 will replace stub
        network:   buildNetwork(deps),    // T7 will replace stub
        log:   (...args) => deps.emitLog({ level: "info",  args }),
        warn:  (...args) => deps.emitLog({ level: "warn",  args }),
        error: (...args) => deps.emitLog({ level: "error", args }),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    };
}

// ---------------------------------------------------------------------------
// instances
// ---------------------------------------------------------------------------

function buildInstances(deps: ToolkitDeps): Toolkit["instances"] {
    const requireRegistry = () => {
        if (!deps.instanceRegistry) throw new Error("not attached: no instance registry");
        return deps.instanceRegistry;
    };

    const matchesLabel = (className: string, friendly: string): boolean => {
        return className === friendly || className === deps.resolveLabel(friendly);
    };

    return {
        async find(label) {
            const reg = requireRegistry();
            const live = reg.list().filter((c) => c.isAlive);
            const matches = live.filter((c) => matchesLabel(c.className, label));
            if (matches.length === 0) throw new Error(`no live captured instance for label '${label}'`);
            if (matches.length > 1)  throw new Error(`label '${label}' has ${matches.length} live matches; use findAll()`);
            const m = matches[0];
            return { className: m.className, handle: m.handle, key: m.key };
        },
        async findAll(label) {
            const reg = requireRegistry();
            return reg.list()
                .filter((c) => c.isAlive)
                .filter((c) => matchesLabel(c.className, label))
                .map((m): InstanceHandle => ({ className: m.className, handle: m.handle, key: m.key }));
        },
        async capture(label, opts?: CaptureOpts) {
            const reg = requireRegistry();
            const className = deps.resolveLabel(label);
            const summary = String(await deps.agentCall("captureInstance", [
                className, opts?.index ?? 0, opts?.asKey ?? null,
            ])).trim();
            const m = summary.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
            if (!m) throw new Error(`capture returned unexpected format: ${summary.slice(0, 120)}`);
            const cls = m[1];
            const handle = m[2];
            const key = opts?.asKey ?? `${cls}@${handle}`;
            reg.set(key, cls, handle, "captureViaGC");
            return { className: cls, handle, key };
        },
        // TODO(T9+): consider a pre-flight isAlive check once handle-invalidation lifecycle is formalized.
        async read(handle, field) {
            return deps.agentCall("readField", [handle.className, handle.handle, field]);
        },
        async write(handle, field, value) {
            await deps.agentCall("writeField", [handle.className, handle.handle, field, value]);
        },
        async call(handle, method, args = []) {
            return deps.agentCall("callMethod", [handle.className, handle.handle, method, args]);
        },
        async list() {
            const reg = requireRegistry();
            return reg.list().map((m): InstanceHandle => ({
                className: m.className, handle: m.handle, key: m.key,
            }));
        },
    };
}

function buildHooks(deps: ToolkitDeps): Toolkit["hooks"] {
    const requireStore = () => {
        if (!deps.hookStore) throw new Error("not attached: no hook store");
        return deps.hookStore;
    };

    return {
        async install(target, opts) {
            const store = requireStore();
            const [className, methodName] = splitTarget(target);
            const spec: HookSpec = {
                className: deps.resolveLabel(className),
                methodName: deps.resolveLabel(methodName),
                template: opts.mode === "modify-return" ? "force-return" : "log",
                ...(opts.returnValue !== undefined ? { forceReturnValue: opts.returnValue } : {}),
            };
            const stored = store.add(spec);
            await store.install(stored.id);
            return { id: stored.id };
        },
        async remove(handle) {
            const store = requireStore();
            await store.remove(handle.id);
        },
        onceCall(target, opts) {
            const store = requireStore();
            const [className, methodName] = splitTarget(target);
            const spec: HookSpec = {
                className: deps.resolveLabel(className),
                methodName: deps.resolveLabel(methodName),
                template: "log",
            };
            const stored = store.add(spec);

            return new Promise<HookCallEvent>((resolve, reject) => {
                let timer: ReturnType<typeof setTimeout> | null = null;

                const unsub = store.onAgentEvent((evt) => {
                    if (evt.hookId !== stored.id) return;
                    if (timer) clearTimeout(timer);
                    unsub();
                    void store.remove(stored.id);
                    resolve({ args: evt.args, ts: evt.ts !== undefined ? new Date(evt.ts).toISOString() : new Date().toISOString() });
                });

                // Now arm the hook (event handler is already in place).
                store.install(stored.id).then(() => {
                    const timeoutMs = opts?.timeoutMs ?? 30_000;
                    timer = setTimeout(() => {
                        unsub();
                        void store.remove(stored.id);
                        reject(new Error(`timeout waiting for ${target} after ${timeoutMs}ms`));
                    }, timeoutMs);
                }).catch((err) => {
                    unsub();
                    void store.remove(stored.id);
                    reject(err instanceof Error ? err : new Error(String(err)));
                });
            });
        },
    };
}

function splitTarget(target: string): [string, string] {
    const dot = target.lastIndexOf(".");
    if (dot < 0) throw new Error(`hook target must be 'Class.Method', got '${target}'`);
    return [target.slice(0, dot), target.slice(dot + 1)];
}

function frameMessageType(typeKey: { ns: string | null; className: string }): string {
    return typeKey.ns ? `${typeKey.ns}.${typeKey.className}` : typeKey.className;
}

function buildNetwork(deps: ToolkitDeps): Toolkit["network"] {
    return {
        async send(messageType, payload) {
            await deps.agentCall("sendPacket", [messageType, payload]);
        },
        async onceReceive(messageType, opts) {
            if (!deps.frameStore) throw new Error("not attached: no frame store");
            const fs = deps.frameStore;
            const timeoutMs = opts?.timeoutMs ?? 30_000;
            return new Promise<NetworkPacket>((resolve, reject) => {
                const listener = (frame: NetworkFrame) => {
                    const mt = frameMessageType(frame.typeKey);
                    if (mt !== messageType) return;
                    clearTimeout(timer);
                    fs.off("frame", listener);
                    resolve({
                        id: frame.id,
                        direction: frame.direction,
                        messageType: mt,
                        payload: frame.fields,
                        ts: frame.timestamp,
                    });
                };
                const timer = setTimeout(() => {
                    fs.off("frame", listener);
                    reject(new Error(`timeout waiting for packet '${messageType}' after ${timeoutMs}ms`));
                }, timeoutMs);
                fs.on("frame", listener);
            });
        },
        async recent(messageType, limit) {
            if (!deps.frameStore) throw new Error("not attached: no frame store");
            const fs = deps.frameStore;
            const all = fs.list({});
            const filtered = messageType
                ? all.filter((f) => frameMessageType(f.typeKey) === messageType)
                : all;
            const limited = filtered.slice(-(limit ?? 100));
            return limited.map((f): NetworkPacket => ({
                id: f.id,
                direction: f.direction,
                messageType: frameMessageType(f.typeKey),
                payload: f.fields,
                ts: f.timestamp,
            }));
        },
    };
}
