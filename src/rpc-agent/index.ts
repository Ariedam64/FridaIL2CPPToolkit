// Frida agent entry point. Compiled by `npm run build:rpc` → build/rpc-agent.js.
import "frida-il2cpp-bridge";
import { getRpcMethods } from "./rpc-methods";
import { installSerializerHooksSync } from "./network-monitor";
import type { SerializerConfig } from "./network-monitor";
import { findClassExact } from "../lib/search";

const rpcMethods = getRpcMethods();
rpc.exports = rpcMethods;

// =============================================================================
// Pre-arm path (opt-in, used by /api/profile/freeze-and-attach).
//
// If the backend posts pre-arm messages BEFORE the process resumes, we install
// hooks inside the SAME Il2Cpp.perform that signals agent-ready — eliminating
// the race window where the game's first C# code could run between IL2CPP
// init and any subsequent RPC. Two kinds of pre-arm hooks are supported:
//   - "pre-arm-config" : network serializer entries (fzc/fzn-style)
//   - "pre-arm-methods" : arbitrary method log-hooks (className+methodName+ns)
//     used to capture e.g. the auth flow constructor calls.
//
// For the normal (post-attach) flow these messages never arrive so this path
// is a no-op.
// =============================================================================

let preArmConfig: SerializerConfig | null = null;
recv("pre-arm-config", (msg: any) => {
    preArmConfig = (msg?.config ?? null) as SerializerConfig | null;
    send({ type: "pre-arm-ack" });
});

interface PreArmMethodHook {
    className: string;
    methodName: string;
    ns?: string;
}
let preArmMethods: PreArmMethodHook[] = [];
recv("pre-arm-methods", (msg: any) => {
    preArmMethods = Array.isArray(msg?.hooks) ? msg.hooks : [];
    send({ type: "pre-arm-methods-ack" });
});

function installPreArmMethodHook(spec: PreArmMethodHook): boolean {
    const fqn = spec.ns ? `${spec.ns}.${spec.className}` : spec.className;
    const klass = findClassExact(fqn) || findClassExact(spec.className);
    if (!klass) return false;
    const method = (klass as any).tryMethod(spec.methodName);
    if (!method) return false;
    const isStatic = method.isStatic;
    const captured: any[] = [];
    method.implementation = function (this: any, ...args: any[]): any {
        try {
            captured.push({
                ts: Date.now(),
                cls: spec.className,
                method: spec.methodName,
                args: args.map((a) => {
                    try { return String(a).slice(0, 200); } catch { return "?"; }
                }),
            });
            // Cap memory.
            if (captured.length > 50) captured.shift();
        } catch {}
        // Forward to original.
        try {
            return isStatic
                ? klass.method(spec.methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(spec.methodName).invoke(...args);
        } catch (e) {
            return null;
        }
    };
    // Stash the captured array on a global so the backend can read it via RPC.
    (globalThis as any).__preArmCaptures = (globalThis as any).__preArmCaptures || {};
    (globalThis as any).__preArmCaptures[`${spec.className}.${spec.methodName}`] = captured;
    return true;
}

// RPC-callable: returns the pre-arm hook captures and optionally clears them.
(rpc.exports as any).getPreArmCaptures = () => {
    return (globalThis as any).__preArmCaptures || {};
};
(rpc.exports as any).clearPreArmCaptures = () => {
    (globalThis as any).__preArmCaptures = {};
    return { ok: true };
};

Il2Cpp.perform(() => {
    if (preArmConfig?.entries?.length) {
        try {
            const r = installSerializerHooksSync(preArmConfig);
            console.log(`[rpc-agent] pre-armed ${r.installed} serializer hook(s); failed=${r.failed.length}`);
        } catch (e) {
            console.log("[rpc-agent] pre-arm install failed: " + String(e).slice(0, 200));
        }
    }
    if (preArmMethods.length > 0) {
        let installed = 0;
        let failed = 0;
        for (const spec of preArmMethods) {
            if (installPreArmMethodHook(spec)) installed++; else failed++;
        }
        console.log(`[rpc-agent] pre-armed ${installed} method hook(s); failed=${failed}`);
    }
    console.log("[rpc-agent] ready. Exposed methods: " + Object.keys(rpcMethods).sort().join(", "));
    send({ type: "agent-ready" });
});
