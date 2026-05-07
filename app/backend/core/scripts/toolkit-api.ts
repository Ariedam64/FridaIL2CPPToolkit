import type { InstanceRegistry } from "../instances/instance-registry";
import type { HookStore } from "../hooks/hook-store";
import type { FrameStore } from "../network/frame-store";
import type {
    Toolkit, InstanceHandle, HookHandle, NetworkPacket, CaptureOpts,
    HookInstallOpts, HookCallEvent, ScriptLog,
} from "./types";

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

// Stubs for T6/T7 (filled in later tasks).
function buildHooks(_deps: ToolkitDeps): Toolkit["hooks"] {
    return {
        async install(_target: string, _opts: HookInstallOpts): Promise<HookHandle> {
            throw new Error("hooks.install: not yet implemented (T6)");
        },
        async remove(_handle: HookHandle): Promise<void> {
            throw new Error("hooks.remove: not yet implemented (T6)");
        },
        async onceCall(_target: string, _opts?: { timeoutMs?: number }): Promise<HookCallEvent> {
            throw new Error("hooks.onceCall: not yet implemented (T6)");
        },
    };
}

function buildNetwork(_deps: ToolkitDeps): Toolkit["network"] {
    return {
        async send(_messageType: string, _payload: Record<string, unknown>): Promise<void> {
            throw new Error("network.send: not yet implemented (T7)");
        },
        async onceReceive(_messageType: string, _opts?: { timeoutMs?: number }): Promise<NetworkPacket> {
            throw new Error("network.onceReceive: not yet implemented (T7)");
        },
        async recent(_messageType?: string, _limit?: number): Promise<NetworkPacket[]> {
            throw new Error("network.recent: not yet implemented (T7)");
        },
    };
}
