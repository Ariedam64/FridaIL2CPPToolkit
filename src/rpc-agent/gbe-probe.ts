// RPC methods to passively probe the gbe dispatcher at runtime.
//
// Why this exists despite startNetworkCapture/startIncomingCapture in network.ts:
//   - those hook the wire boundary (ecu.xbe outgoing, fzk.Decode incoming)
//   - this hooks the APPLICATION boundary (gbe.bidi etc.) — the moment the
//     dispatcher routes a decoded protobuf message to its registered handler.
//   - measuring at this layer gives us per-type counts and latencies that
//     correlate directly with feature activity (UI panel, fight, inventory).
//
// Safety contract: this is the "ciblé" sniffer, not "intercept-tout". It hooks
// 1-3 methods total, never logs per-call to console (silent counters), and
// auto-bounds the message-class history (LRU). Earlier full-network sniffers
// crashed the PC; this one is engineered to stay quiet.

import "frida-il2cpp-bridge";
import { findClass } from "../lib";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

interface ProbeCounter {
    typeName: string;          // CLR Type.FullName of the protobuf message
    typeShortName: string;     // obfuscated short class name
    calls: number;
    firstSeenTs: number;
    lastSeenTs: number;
}

interface InstalledProbe {
    klass: string;
    method: string;
    overloadKey: string;
}

const counters = new Map<string, ProbeCounter>();
const installed: InstalledProbe[] = [];
let totalCalls = 0;
let firstHookTs = 0;

function getOrInit(typeShortName: string, typeName: string): ProbeCounter {
    let c = counters.get(typeShortName);
    if (!c) {
        c = { typeName, typeShortName, calls: 0, firstSeenTs: Date.now(), lastSeenTs: 0 };
        counters.set(typeShortName, c);
    }
    return c;
}

function hookMethod(klassName: string, methodName: string, paramTypes: string[], typeArgIndex: number, msgArgIndex: number): boolean {
    const klass = findClass(klassName);
    if (!klass) return false;
    let method: Il2Cpp.Method<any>;
    try {
        method = klass.method(methodName).overload(...paramTypes);
    } catch {
        return false;
    }
    const overloadKey = paramTypes.join(",");

    method.implementation = function (this: any, ...args: any[]): any {
        try {
            // Prefer the explicit Type arg; fall back to msg.GetType() if Type is null.
            let typeShort = "?";
            let typeFull = "?";
            const typeArg = typeArgIndex >= 0 ? args[typeArgIndex] : null;
            const msgArg = msgArgIndex >= 0 ? args[msgArgIndex] : null;

            if (typeArg && (typeArg as any).method) {
                try { typeFull = String((typeArg as any).method("get_FullName").invoke()).replace(/^"|"$/g, ""); } catch {}
                try { typeShort = String((typeArg as any).method("get_Name").invoke()).replace(/^"|"$/g, ""); } catch {}
            } else if (msgArg && (msgArg as any).class) {
                typeShort = (msgArg as any).class.name;
                typeFull = (msgArg as any).class.fullName ?? typeShort;
            }
            if (typeShort && typeShort !== "?") {
                const c = getOrInit(typeShort, typeFull);
                c.calls++;
                c.lastSeenTs = Date.now();
                totalCalls++;
            }
        } catch { /* never let probe break dispatcher */ }
        const self = this as Il2Cpp.Object;
        if (method.isStatic) return klass.method(methodName).overload(...paramTypes).invoke(...args);
        return self.method(methodName).overload(...paramTypes).invoke(...args);
    };

    installed.push({ klass: klassName, method: methodName, overloadKey });
    console.log(`[gbe-probe] hooked ${klassName}.${methodName}(${overloadKey})`);
    return true;
}

/**
 * Install the probe on the gbe dispatch entry points. Default targets ONLY
 * the public bidi(Type, IMessage, fzz, gaa) — the central UniTask dispatcher.
 *
 * `extras` opts you into the sibling forwarders (kvj, iad, jsl, otz, bidj).
 * Each extra hook adds overhead per call; on a chatty event bus the combined
 * cost can degrade gameplay. Default is [] for safety. Pass them explicitly
 * when you need finer-grained accounting and accept the perf cost.
 */
export function installGbeProbe(extras: string[] = []): Promise<{ installed: number; total: number; details: InstalledProbe[]; }> {
    return inVm(() => {
        const before = installed.length;
        if (firstHookTs === 0) firstHookTs = Date.now();

        // Public dispatcher entry — UniTask bidi(Type, IMessage, fzz, gaa).
        hookMethod("gbe", "bidi",
            ["System.Type", "Google.Protobuf.IMessage", "fzz", "gaa"],
            0, 1);

        // Same shape as bidi — internal forwarders / queue feeders.
        for (const name of extras) {
            hookMethod("gbe", name,
                ["System.Type", "Google.Protobuf.IMessage", "fzz", "gaa"],
                0, 1);
        }

        return {
            installed: installed.length - before,
            total: installed.length,
            details: installed.slice(before),
        };
    });
}

/** Snapshot the current counter table. Sorted by call count, descending. */
export function getGbeProbeStats(limit: number = 1000): Promise<{
    sinceTs: number;
    elapsedMs: number;
    totalCalls: number;
    distinctTypes: number;
    hooks: InstalledProbe[];
    counters: ProbeCounter[];
}> {
    return inVm(() => {
        const arr = [...counters.values()].sort((a, b) => b.calls - a.calls).slice(0, limit);
        return {
            sinceTs: firstHookTs,
            elapsedMs: firstHookTs ? Date.now() - firstHookTs : 0,
            totalCalls,
            distinctTypes: counters.size,
            hooks: installed.slice(),
            counters: arr,
        };
    });
}

/** Empty the counter table without touching the hooks. */
export function clearGbeProbeStats(): Promise<number> {
    return inVm(() => {
        const n = counters.size;
        counters.clear();
        totalCalls = 0;
        firstHookTs = Date.now();
        return n;
    });
}
