/* =============================================================================
 * TOOL 99 — RPC AGENT (advanced)
 * =============================================================================
 * But :
 *   Un AGENT UNIQUE et persistant qui s'attache une fois au jeu et expose toute
 *   la lib via RPC. Tu le pilotes ensuite depuis :
 *     - un hôte Node (TypeScript CLI, REPL, scénarios scriptés)
 *     - ou directement avec la CLI frida : rpc.exports.foo(...)
 *
 *   Avantage vs les tools 01–06 : pas besoin de recompiler/relancer pour chaque
 *   action. Tu explores le jeu interactivement.
 *
 * Build :
 *   npm run build:rpc
 *
 * Run (mode CLI interactive) :
 *   frida -l build/rpc-agent.js -n FridaCobaye.exe --no-pause -i
 *   > rpc.exports.analyze()
 *   > rpc.exports.find('Player')
 *   > rpc.exports.hook('Player', 'TakeDamage')
 *   > rpc.exports.patchStatic('Player', 'totalPlayersAlive', 999)
 *
 * Run (mode hôte Node — voir host/cli.ts à créer plus tard) :
 *   node host/cli.js
 *
 * Exposed API :
 *   analyze()                             → full analyze
 *   find(pattern)                         → liste les classes matchant
 *   dumpClass(name)                       → dump structurel d'une classe
 *   dumpStatics(name)                     → dump des statics d'une classe
 *   hook(className, methodName)           → log-hook une méthode
 *   replaceNoop(className, methodName)    → no-op sur une méthode (god-mode pattern)
 *   patchStatic(className, field, value)  → écrit un static field
 *   forceReturn(className, method, value) → force une valeur de retour
 *   callStatic(className, method, args)   → appelle une méthode statique
 *
 * Limite RPC : les valeurs retournées doivent être sérialisables en JSON.
 * Pour un Il2Cpp.Object, on renvoie son nom et son handle stringifié.
 * =============================================================================
 */

import "frida-il2cpp-bridge";
import { findClass, stringifyValue } from "../lib";
import * as searchRpc from "../rpc-agent/search";
import * as explorerRpc from "../rpc-agent/explorer";
import * as hooksRpc from "../rpc-agent/hooks";
import * as instanceOpsRpc from "../rpc-agent/instance-ops";

// Wrapper: Il2Cpp.perform is async (returns Promise). Frida RPC exports can
// return promises — the host will await them automatically. So we just return
// the perform() promise directly.
function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

rpc.exports = {
    ...searchRpc,
    ...explorerRpc,
    ...hooksRpc,
    ...instanceOpsRpc,

    // ========== network capture ==========

    /**
     * Network capture — hook the game's outbound send path and emit one {type:'socket', direction:'out'}
     * event per message. `sendClass` / `sendMethod` default to Dofus Unity (ecu.xbe), override for other games.
     * Each event carries the IMessage class name and a ToString() preview of the payload.
     */
    startNetworkCapture(sendClass: string = "ecu", sendMethod: string = "xbe"): Promise<string> {
        return inVm(() => {
            const klass = findClass(sendClass);
            if (!klass) throw new Error(`class ${sendClass} not found`);
            const method = klass.tryMethod(sendMethod);
            if (!method) throw new Error(`method ${sendMethod} not found on ${sendClass}`);

            // Pre-resolve all protobuf message descriptors at startup. We can safely call
            // managed methods here (we're in Il2Cpp.perform, not inside a hook). The cache
            // maps obfuscated class name → descriptor Name/FullName.
            const nameCache = new Map<string, { name: string; fullName: string }>();
            console.log(`[net] pre-resolving protobuf descriptors…`);
            const t0 = Date.now();
            let resolved = 0, errored = 0;
            for (const asm of Il2Cpp.domain.assemblies) {
                try {
                    for (const k of asm.image.classes) {
                        // Find any static no-arg method returning MessageDescriptor
                        let getter = null as Il2Cpp.Method<any> | null;
                        for (const m of k.methods) {
                            if (m.isStatic && m.parameters.length === 0 &&
                                m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                                getter = m; break;
                            }
                        }
                        if (!getter) continue;
                        try {
                            // Force class static constructor to run (some Dofus protocol types
                            // throw "system error" unless their cctor / file reflection init fires first)
                            try { (k as any).initialize?.(); } catch {}
                            const desc = getter.invoke() as Il2Cpp.Object;
                            if (!desc) continue;
                            const name = stringifyValue(desc.method("get_Name").invoke()).replace(/^"|"$/g, "");
                            const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
                            nameCache.set(k.name, { name, fullName });
                            resolved++;
                        } catch { errored++; }
                    }
                } catch {}
            }
            console.log(`[net] resolved ${resolved} descriptors (${errored} errors) in ${Date.now() - t0}ms`);

            method.implementation = function (this: any, ...args: any[]): any {
                const msg = args[0] as Il2Cpp.Object | undefined;
                let cls = "?", name = "?", fullName = "?";
                const fields: Record<string, string> = {};
                try { if (msg && (msg as any).class) cls = (msg as any).class.name; } catch {}
                const cached = nameCache.get(cls);
                if (cached) { name = cached.name; fullName = cached.fullName; }
                // Dump instance fields (safer than ToString for obfuscated protobuf messages)
                try {
                    if (msg && (msg as any).class) {
                        for (const f of (msg as any).class.fields) {
                            if (f.isStatic) continue;
                            try {
                                const v = (msg as any).field(f.name).value;
                                const s = stringifyValue(v);
                                if (s !== "null" && s !== "0" && s !== "false" && s !== "\"\"" && !s.endsWith("@0x0")) {
                                    fields[f.name] = s.slice(0, 200);
                                }
                            } catch {}
                        }
                    }
                } catch {}
                send({ type: "socket", direction: "out", cls, name, fullName, fields, ts: Date.now() });
                const self = this as Il2Cpp.Object;
                return self.method(sendMethod).invoke(...args);
            };
            console.log(`[net] capture armed on ${sendClass}.${sendMethod} (outgoing)`);
            return `hooked ${sendClass}.${sendMethod} · ${resolved} protobuf types mapped`;
        });
    },

    /** Test: resolve descriptor for a single class by name. Returns { found, name, fullName, reason } */
    resolveProtobufName(className: string): Promise<any> {
        return inVm(() => {
            const k = findClass(className);
            if (!k) return { found: false, reason: "class not found" };
            // List all MessageDescriptor-returning methods
            const candidates: Array<{ name: string; isStatic: boolean; paramCount: number }> = [];
            for (const m of k.methods) {
                if (m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor") {
                    candidates.push({ name: m.name, isStatic: m.isStatic, paramCount: m.parameters.length });
                }
            }
            if (candidates.length === 0) return { found: false, reason: "no MessageDescriptor-returning method", methodCount: k.methods.length };
            // Try the first static no-arg one
            const staticGetter = k.methods.find(m => m.isStatic && m.parameters.length === 0 && m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor");
            if (!staticGetter) return { found: false, reason: "no static no-arg getter", candidates };
            try {
                const desc = staticGetter.invoke() as Il2Cpp.Object;
                if (!desc) return { found: false, reason: "getter returned null", candidates };
                const name = stringifyValue(desc.method("get_Name").invoke()).replace(/^"|"$/g, "");
                const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
                return { found: true, name, fullName, candidates };
            } catch (e) {
                return { found: false, reason: `invoke err: ${e}`, candidates };
            }
        });
    },

    /** Sample the descriptor cache (for debugging): which protobuf types resolved successfully */
    sampleResolvedProtobufs(): Promise<string[]> {
        return inVm(() => {
            const out: string[] = [];
            let count = 0;
            for (const asm of Il2Cpp.domain.assemblies) {
                try {
                    for (const k of asm.image.classes) {
                        const staticGetter = k.methods.find(m => m.isStatic && m.parameters.length === 0 && m.returnType.name === "Google.Protobuf.Reflection.MessageDescriptor");
                        if (!staticGetter) continue;
                        try {
                            const desc = staticGetter.invoke() as Il2Cpp.Object;
                            if (!desc) continue;
                            const fullName = stringifyValue(desc.method("get_FullName").invoke()).replace(/^"|"$/g, "");
                            out.push(`${k.name} → ${fullName}`);
                            count++;
                            if (count >= 30) return out;
                        } catch {}
                    }
                } catch {}
            }
            return out;
        });
    },

    stopNetworkCapture(sendClass: string = "ecu", sendMethod: string = "xbe"): Promise<string> {
        return inVm(() => {
            const klass = findClass(sendClass);
            if (!klass) throw new Error(`class ${sendClass} not found`);
            const method = klass.tryMethod(sendMethod);
            if (!method) throw new Error(`method not found`);
            method.revert();
            console.log(`[net] capture reverted on ${sendClass}.${sendMethod}`);
            return "reverted";
        });
    },
};

Il2Cpp.perform(() => {
    console.log("[rpc-agent] ready. Exposed: analyze, find, dumpClass, dumpStatics, hook, replaceNoop, patchStatic, forceReturn, callStatic");
    send({ type: "agent-ready" });
});
