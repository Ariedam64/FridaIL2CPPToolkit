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
import {
    fullAnalyze,
    findAllClasses,
    findByField,
    findByMethod,
    findClass,
    fullClassName,
    dumpClass,
    dumpStatics,
    dumpFields,
    hookLog,
    hookNoop,
    setStatic,
    forceReturn,
    callStatic,
    stringifyValue,
    findStringInMemory,
} from "../lib";

// Registry of captured live instances, keyed by class name.
// Populated by `capture(className, tickMethod)` via a one-shot hook.
const captured = new Map<string, Il2Cpp.Object>();

function getCaptured(className: string): Il2Cpp.Object {
    const inst = captured.get(className);
    if (!inst) throw new Error(`no captured instance for ${className}. Call capture(${className}, <tickMethod>) first.`);
    return inst;
}

/** Coerce a JSON-sent value to the IL2CPP type expected by `typeName`. */
function coerce(value: any, typeName: string): any {
    if (value === undefined || value === null) return value;
    if (typeName === "System.String" && typeof value === "string") return Il2Cpp.string(value);

    // List<T> from a JS array — tolerate several type-name shapes
    //   System.Collections.Generic.List`1<System.UInt32>
    //   System.Collections.Generic.List<System.UInt32>
    //   List`1<System.UInt32>
    if (Array.isArray(value)) {
        const listMatch = typeName.match(/List`?\d*<(.+)>$/);
        if (listMatch) {
            console.log(`[coerce] building List<${listMatch[1]}> from [${value.join(", ")}]`);
            return buildList(listMatch[1].trim(), value);
        }
        console.log(`[coerce] got array but typeName "${typeName}" is not List<T> — passing raw`);
    }
    return value;
}

/** Build a C# List<T> from a JS array. Works for primitives and ref types. */
function buildList(elemTypeName: string, values: any[]): Il2Cpp.Object {
    let elemClass: Il2Cpp.Class | null = null;
    try { elemClass = Il2Cpp.corlib.class(elemTypeName); } catch {}
    if (!elemClass) elemClass = findClass(elemTypeName);
    if (!elemClass) throw new Error(`cannot resolve element type ${elemTypeName}`);

    const listGen = Il2Cpp.corlib.class("System.Collections.Generic.List`1");
    const listInflated = listGen.inflate(elemClass);
    const list = listInflated.new();
    list.method(".ctor").invoke();
    const addMethod = list.method("Add");
    for (const v of values) {
        addMethod.invoke(coerce(v, elemTypeName));
    }
    return list;
}

// Wrapper: Il2Cpp.perform is async (returns Promise). Frida RPC exports can
// return promises — the host will await them automatically. So we just return
// the perform() promise directly.
function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// ---------- inheritance cache (lazy, built on first listSubclasses call) ----
let inheritanceCache: Map<string, string[]> | null = null;
function ensureInheritanceCache(): void {
    if (inheritanceCache) return;
    const map = new Map<string, string[]>();
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            for (const k of asm.image.classes) {
                const parent = k.parent;
                if (!parent) continue;
                const childName = fullClassName(k);
                for (const key of [parent.name, fullClassName(parent)]) {
                    if (!map.has(key)) map.set(key, []);
                    if (!map.get(key)!.includes(childName)) map.get(key)!.push(childName);
                }
            }
        } catch {}
    }
    for (const arr of map.values()) arr.sort();
    inheritanceCache = map;
    console.log(`[explorer] inheritance cache built: ${map.size} parents`);
}

rpc.exports = {
    analyze(): Promise<void> {
        return inVm(() => fullAnalyze());
    },
    find(pattern: string, limit = 50): Promise<string[]> {
        return inVm(() => findAllClasses(pattern, limit).map(fullClassName));
    },
    findByField(typePattern: string | null, namePattern: string | null, limit = 50): Promise<string[]> {
        return inVm(() =>
            findByField(typePattern || null, namePattern || null, limit)
                .map(m => `${fullClassName(m.class)}  ::  ${m.type} ${m.field}`)
        );
    },
    findByMethod(opts: { returnType?: string; paramType?: string; name?: string }, limit = 50): Promise<string[]> {
        return inVm(() =>
            findByMethod(opts || {}, limit)
                .map(m => `${fullClassName(m.class)}  ::  ${m.signature}`)
        );
    },
    findStringInMemory(text: string, maxHits = 10): Promise<string[]> {
        return inVm(() => findStringInMemory(text, maxHits));
    },

    // ========== explorer (tree view) ==========

    /** List assemblies + class count. Returns array of { name, classes }. */
    listAssembliesInfo(): Promise<Array<{ name: string; classes: number }>> {
        return inVm(() => {
            const out: Array<{ name: string; classes: number }> = [];
            for (const asm of Il2Cpp.domain.assemblies) {
                let n = 0;
                try { n = asm.image.classes.length; } catch {}
                out.push({ name: asm.name, classes: n });
            }
            out.sort((a, b) => b.classes - a.classes);
            return out;
        });
    },

    /** List distinct namespaces in an assembly (+ class count per namespace). */
    listNamespaces(assemblyName: string): Promise<Array<{ ns: string; classes: number }>> {
        return inVm(() => {
            const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
            if (!asm) throw new Error(`assembly ${assemblyName} not found`);
            const counts = new Map<string, number>();
            for (const c of asm.image.classes) {
                const ns = c.namespace ?? "(root)";
                counts.set(ns, (counts.get(ns) ?? 0) + 1);
            }
            const out = [...counts.entries()].map(([ns, classes]) => ({ ns, classes }));
            out.sort((a, b) => a.ns.localeCompare(b.ns));
            return out;
        });
    },

    /** List class names (simple names) in a specific assembly + namespace. */
    listClassesIn(assemblyName: string, ns: string): Promise<string[]> {
        return inVm(() => {
            const asm = Il2Cpp.domain.assemblies.find(a => a.name === assemblyName);
            if (!asm) throw new Error(`assembly ${assemblyName} not found`);
            const wanted = ns === "(root)" ? "" : ns;
            const out: string[] = [];
            for (const c of asm.image.classes) {
                if ((c.namespace ?? "") === wanted) out.push(c.name);
            }
            return out.sort();
        });
    },

    /**
     * Direct subclasses of `baseName` (exact match on parent's simple or full name).
     * Cached after the first call for fast traversal.
     */
    listSubclasses(baseName: string, limit = 500): Promise<string[]> {
        return inVm(() => {
            ensureInheritanceCache();
            return (inheritanceCache!.get(baseName) ?? []).slice(0, limit);
        });
    },

    dumpClass(name: string): Promise<void> {
        return inVm(() => {
            const k = findClass(name);
            if (k) dumpClass(k);
            else console.log(`[rpc] class ${name} not found`);
        });
    },
    dumpStatics(name: string): Promise<void> {
        return inVm(() => {
            const k = findClass(name);
            if (k) dumpStatics(k);
            else console.log(`[rpc] class ${name} not found`);
        });
    },
    hook(className: string, methodName: string): Promise<void> {
        return inVm(() => hookLog(className, methodName));
    },
    replaceNoop(className: string, methodName: string): Promise<void> {
        return inVm(() => hookNoop(className, methodName));
    },
    patchStatic(className: string, field: string, value: any): Promise<void> {
        return inVm(() => setStatic(className, field, value));
    },
    forceReturn(className: string, method: string, value: any): Promise<void> {
        return inVm(() => forceReturn(className, method, value));
    },
    callStatic(className: string, method: string, args: any[] = []): Promise<string> {
        return inVm(() => {
            const res = callStatic(className, method, ...args);
            return String(res);
        });
    },

    /**
     * Call a static method with explicit parameter-type overload resolution.
     * Ex: callStaticOverload("Core.Localization.LocalizedStringUtilities", "GetLocalized", ["System.Int32"], [1167735])
     */
    callStaticOverload(className: string, methodName: string, paramTypes: string[], args: any[] = []): Promise<string> {
        return inVm(() => {
            const klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const method = klass.method(methodName).overload(...paramTypes);
            const coerced = args.map((v, i) => coerce(v, paramTypes[i]));
            const res = method.invoke(...coerced);
            return stringifyValue(res);
        });
    },

    // ========== live instances ==========

    /**
     * Hook `tickMethod` once on `className` to steal the first `this` and store
     * it in the captured registry. Resolves to a summary like "Player@0x1234".
     */
    capture(className: string, tickMethod: string, timeoutMs?: number): Promise<string> {
        const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 10000;
        return inVm(() => new Promise<string>((resolve, reject) => {
            const klass = findClass(className);
            if (!klass) return reject(`class ${className} not found`);
            const method = klass.tryMethod(tickMethod);
            if (!method) return reject(`method ${tickMethod} not found on ${className}`);
            if (method.isStatic) return reject(`${tickMethod} is static, cannot capture instance`);

            let done = false;
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                try { method.revert(); } catch {}
                reject(`capture timeout (${ms}ms) on ${className}.${tickMethod}`);
            }, ms);

            method.implementation = function (this: Il2Cpp.Class | Il2Cpp.Object | Il2Cpp.ValueType, ...args: any[]): any {
                const self = this as Il2Cpp.Object;
                if (!done) {
                    done = true;
                    clearTimeout(timer);
                    captured.set(className, self);
                    const summary = `${self.class.name}@${self.handle}`;
                    console.log(`[capture] stored ${className} → ${summary}`);
                    try { method.revert(); } catch {}
                    resolve(summary);
                }
                return self.method(tickMethod).invoke(...args);
            };
            console.log(`[capture] armed on ${className}.${tickMethod}, waiting…`);
        }));
    },

    listCaptured(): Promise<string[]> {
        return inVm(() => {
            const out: string[] = [];
            captured.forEach((inst, name) => out.push(`${name} → ${inst.class.name}@${inst.handle}`));
            return out;
        });
    },

    /**
     * List currently-alive instances of a class via the managed GC.
     * Works for most managed classes, but typically MISSES MonoBehaviours
     * (those need capture(cls, tickMethod)).
     */
    listInstances(className: string, max = 20): Promise<string[]> {
        return inVm(() => {
            const klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const instances = Il2Cpp.gc.choose(klass);
            const shown = Math.min(max, instances.length);
            const out: string[] = [];
            for (let i = 0; i < shown; i++) {
                out.push(`[${i}] ${instances[i].class.name}@${instances[i].handle}`);
            }
            if (instances.length > max) out.push(`… and ${instances.length - max} more (total ${instances.length})`);
            if (!instances.length) out.push(`(none — try captureViaHook for MonoBehaviours)`);
            return out;
        });
    },

    /**
     * Pick one live instance via GC and store it in the captured registry.
     * Defaults to the first (index=0). Use listInstances() first if multiple.
     */
    /**
     * Capture the Nth element of a List<T>-typed field on an already-captured instance.
     * Stores it in the registry under `asKey` (so you can later call read/write/callInstance on it).
     * Example: element 0 of AuctionHouseBuy.m_openedItems stored as key "openedItem0".
     */
    /**
     * Capture a reference-typed field of an already-captured instance.
     * Ex: captureFieldValue("openedItem", "<item>k__BackingField", "itemData")
     *     → stores openedItem.<item>BackingField under key "itemData".
     */
    captureFieldValue(ownerKey: string, fieldName: string, asKey: string): Promise<string> {
        return inVm(() => {
            const owner = getCaptured(ownerKey);
            const value = owner.field(fieldName).value as Il2Cpp.Object;
            if (!value || (value.handle as any)?.isNull?.()) throw new Error(`${fieldName} is null`);
            captured.set(asKey, value);
            const summary = `${value.class.name}@${value.handle}`;
            console.log(`[capture] ${ownerKey}.${fieldName} stored as "${asKey}" → ${summary}`);
            return summary;
        });
    },

    /**
     * Call a method on an already-captured instance and capture its (reference-typed) return value.
     * Ex: captureMethodReturn("openedItem", "get_item", [], "itemData")
     */
    captureMethodReturn(ownerKey: string, methodName: string, args: any[] = [], asKey: string = ""): Promise<string> {
        return inVm(() => {
            const owner = getCaptured(ownerKey);
            const method = owner.method(methodName);
            const coerced = args.map((v, i) => {
                const t = method.parameters[i]?.type?.name;
                return t ? coerce(v, t) : v;
            });
            const result = method.invoke(...coerced) as Il2Cpp.Object;
            if (!result || (result.handle as any)?.isNull?.()) throw new Error(`return of ${methodName}() is null`);
            const key = asKey || `${ownerKey}.${methodName}`;
            captured.set(key, result);
            const summary = `${result.class.name}@${result.handle}`;
            console.log(`[capture] ${ownerKey}.${methodName}() stored as "${key}" → ${summary}`);
            return summary;
        });
    },

    captureListElement(
        listClassName: string,
        listFieldName: string,
        index: number,
        asKey: string,
    ): Promise<string> {
        return inVm(() => {
            const owner = getCaptured(listClassName);
            const listObj = owner.field(listFieldName).value as Il2Cpp.Object;
            if (!listObj || (listObj.handle as any)?.isNull?.()) throw new Error(`${listFieldName} is null`);

            let elem: Il2Cpp.Object | null = null;
            try {
                const items = (listObj as any).tryField?.("_items")?.value;
                if (items) elem = items.get(index) as Il2Cpp.Object;
                else elem = listObj.method("get_Item").invoke(index) as Il2Cpp.Object;
            } catch (e) { throw new Error(`fetch [${index}] failed: ${e}`); }

            if (!elem || (elem.handle as any)?.isNull?.()) throw new Error(`element [${index}] is null`);
            captured.set(asKey, elem);
            const summary = `${elem.class.name}@${elem.handle}`;
            console.log(`[capture] ${listClassName}.${listFieldName}[${index}] stored as "${asKey}" → ${summary}`);
            return summary;
        });
    },

    captureViaGC(className: string, index = 0): Promise<string> {
        return inVm(() => {
            const klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const instances = Il2Cpp.gc.choose(klass);
            if (!instances.length) throw new Error(`no live instance of ${className}. If it's a MonoBehaviour, use capture(cls, tickMethod) instead.`);
            const idx = index | 0;
            if (idx < 0 || idx >= instances.length) throw new Error(`index ${idx} out of range (${instances.length} alive)`);
            const inst = instances[idx];
            captured.set(className, inst);
            const summary = `${inst.class.name}@${inst.handle}`;
            console.log(`[capture] via GC: ${className} [${idx}] → ${summary}`);
            return summary;
        });
    },

    dumpInstance(className: string): Promise<void> {
        return inVm(() => dumpFields(getCaptured(className)));
    },

    readField(className: string, fieldName: string): Promise<string> {
        return inVm(() => stringifyValue(getCaptured(className).field(fieldName).value));
    },

    /** Dump all non-static fields of a captured instance, returning them as an array of strings. */
    /**
     * Call every no-arg method with the given return type on a captured instance.
     * Useful against obfuscation when you know "somewhere there's a get_name() returning String"
     * but the name is mangled. Returns method-name=stringifiedResult for non-null, non-empty outputs.
     */
    /** List all methods of a captured instance's class (or a named class). Returns signatures. */
    listMethods(className: string, nameFilter: string = ""): Promise<string[]> {
        return inVm(() => {
            let klass: Il2Cpp.Class | null = null;
            const cap = captured.get(className);
            if (cap) klass = cap.class;
            else klass = findClass(className);
            if (!klass) throw new Error(`class ${className} not found`);
            const re = nameFilter ? new RegExp(nameFilter, "i") : null;
            const out: string[] = [`class: ${fullClassName(klass)}  methods:`];
            for (const m of klass.methods) {
                if (re && !re.test(m.name)) continue;
                const kind = m.isStatic ? "static " : "       ";
                const params = m.parameters.map(p => `${p.type.name} ${p.name}`).join(", ");
                out.push(`  ${kind}${m.returnType.name.padEnd(20)} ${m.name}(${params})`);
            }
            return out;
        });
    },

    probeNoArgGetters(className: string, returnType: string = "System.String", includeEmpty = false, includeErrors = false): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const out: string[] = [];
            let tested = 0, ok = 0, failed = 0;
            out.push(`class: ${inst.class.name}  probing for no-arg methods returning ${returnType}`);
            for (const m of inst.class.methods) {
                if (m.isStatic) continue;
                if (m.parameters.length !== 0) continue;
                if (m.returnType.name !== returnType) continue;
                tested++;
                try {
                    const bound = inst.method(m.name);
                    const r = bound.invoke();
                    const s = stringifyValue(r);
                    const isEmpty = s === "null" || s === "\"\"" || s === "undefined" || s === "0";
                    if (includeEmpty || !isEmpty) {
                        out.push(`  ${m.name}() = ${s}`);
                        if (!isEmpty) ok++;
                    }
                } catch (e) {
                    failed++;
                    if (includeErrors) out.push(`  ${m.name}() = <err: ${String(e).slice(0, 80)}>`);
                }
            }
            out.push(`(tested ${tested}, non-empty ${ok}, failed ${failed})`);
            return out;
        });
    },

    readAllFields(className: string): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const out: string[] = [];
            out.push(`class: ${inst.class.name}`);
            for (const f of inst.class.fields) {
                if (f.isStatic) continue;
                try {
                    const v = stringifyValue(inst.field(f.name).value);
                    out.push(`  ${f.type.name.padEnd(30)} ${f.name.padEnd(40)} = ${v}`);
                } catch (e) {
                    out.push(`  ${f.type.name.padEnd(30)} ${f.name.padEnd(40)} = <err: ${e}>`);
                }
            }
            return out;
        });
    },

    writeField(className: string, fieldName: string, value: any): Promise<string> {
        return inVm(() => {
            const inst = getCaptured(className);
            const field = inst.field(fieldName);
            field.value = coerce(value, field.type.name) as any;
            const after = stringifyValue(field.value);
            console.log(`[patch] ${className}.${fieldName} = ${after}`);
            return after;
        });
    },

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

    callInstance(className: string, methodName: string, args: any[] = []): Promise<string> {
        return inVm(() => {
            const inst = getCaptured(className);
            const method = inst.method(methodName);
            const coerced = args.map((v, i) => {
                const t = method.parameters[i]?.type?.name;
                return t ? coerce(v, t) : v;
            });
            const res = method.invoke(...coerced);
            const s = stringifyValue(res);
            console.log(`[invoke] ${className}.${methodName}(${coerced.map(stringifyValue).join(", ")}) → ${s}`);
            return s;
        });
    },

    /**
     * Read elements of a List<T>-typed field on a captured instance.
     * - For primitive T (Int32, UInt32, Int64, String…): returns values stringified.
     * - For reference T: returns "ClassName@handle".
     * Handles null lists and shows truncation info.
     */
    /**
     * Enumerate a List<T>-typed field and call the given methods on each element.
     * Returns one summary line per element: `[i] Class  method1=val  method2=val …`.
     */
    enumerateList(
        className: string,
        fieldName: string,
        methods: string[] = [],
        limit = 50,
    ): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const listObj = inst.field(fieldName).value as Il2Cpp.Object;
            if (!listObj || (listObj.handle as any)?.isNull?.()) return ["(null)"];

            let items: Il2Cpp.Array<any> | null = null;
            let size = -1;
            try { const sz = (listObj as any).tryField?.("_size")?.value; if (typeof sz === "number") size = sz; } catch {}
            try { const arr = (listObj as any).tryField?.("_items")?.value; if (arr && typeof (arr as any).length === "number") items = arr as any; } catch {}
            if (size < 0) {
                try { size = listObj.method<number>("get_Count").invoke() as number; } catch (e) { return [`<err get_Count: ${e}>`]; }
            }

            const max = Math.min(limit, size);
            const out: string[] = [`count: ${size}  (showing ${max})`];

            for (let i = 0; i < max; i++) {
                let elem: any;
                try {
                    elem = items ? items.get(i) : listObj.method("get_Item").invoke(i);
                } catch (e) {
                    out.push(`[${i}] <err fetch: ${e}>`);
                    continue;
                }
                if (!elem || (elem.handle?.isNull?.())) { out.push(`[${i}] null`); continue; }
                const klass = elem.class?.name ?? "?";
                const parts: string[] = [`[${i}] ${klass}@${elem.handle}`];
                for (const m of methods) {
                    try {
                        const r = elem.method(m).invoke();
                        parts.push(`${m}=${stringifyValue(r)}`);
                    } catch (e) {
                        parts.push(`${m}=<err>`);
                    }
                }
                out.push(parts.join("  "));
            }
            if (size > max) out.push(`… ${size - max} more (raise limit)`);
            return out;
        });
    },

    /**
     * Read entries of a Dictionary<K,V>-typed field on a captured instance.
     * Iterates the internal `_entries` array (bypasses generic get_Item, which can crash).
     * Returns "[i] key → value" lines. Caps at `limit` real entries.
     */
    /**
     * Look up a single value by key in a Dictionary<K,V> field.
     * Uses the internal `_entries` array (safe for primitive-keyed dicts).
     * `key` is matched against entry.key via strict equality on the stringified value.
     */
    dictGet(className: string, fieldName: string, key: any): Promise<string> {
        return inVm(() => {
            const inst = getCaptured(className);
            const dict = inst.field(fieldName).value as Il2Cpp.Object;
            if (!dict || (dict.handle as any)?.isNull?.()) return "(null dict)";
            let entries: Il2Cpp.Array<any> | null = null;
            for (const n of ["_entries", "entries"]) {
                try { const a = (dict as any).tryField?.(n)?.value; if (a && typeof a.length === "number") { entries = a; break; } } catch {}
            }
            if (!entries) throw new Error("no _entries field");
            const keyStr = String(key);
            for (let i = 0; i < entries.length; i++) {
                let entry: any;
                try { entry = entries.get(i); } catch { continue; }
                if (!entry) continue;
                let k: any;
                try { k = entry.field("key").value; } catch { try { k = entry.field("Key").value; } catch { continue; } }
                if (String(k) !== keyStr) continue;
                let v: any;
                try { v = entry.field("value").value; } catch { try { v = entry.field("Value").value; } catch { return "<value read failed>"; } }
                return stringifyValue(v);
            }
            return "(not in dict)";
        });
    },

    readDict(className: string, fieldName: string, limit = 50): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const dict = inst.field(fieldName).value as Il2Cpp.Object;
            if (!dict || (dict.handle as any)?.isNull?.()) return ["(null)"];

            const out: string[] = [`type: ${dict.class.name}`];
            let total = -1;
            try { total = dict.method<number>("get_Count").invoke() as number; } catch {}
            out.push(`count: ${total}`);

            let entries: Il2Cpp.Array<any> | null = null;
            for (const n of ["_entries", "entries"]) {
                try { const a = (dict as any).tryField?.(n)?.value; if (a && typeof a.length === "number") { entries = a; break; } } catch {}
            }
            if (!entries) { out.push("<no _entries array found>"); return out; }

            let shown = 0;
            for (let i = 0; i < entries.length && shown < limit; i++) {
                let entry: any;
                try { entry = entries.get(i); } catch { continue; }
                if (!entry) continue;
                let hashCode: any = 0;
                try { hashCode = entry.field("hashCode").value; } catch { try { hashCode = entry.field("HashCode").value; } catch {} }
                // skip free/empty slots (convention: hashCode < 0 or next < -1)
                // be permissive: try reading key — if it fails or is null, skip
                let key: any, value: any;
                try { key = entry.field("key").value; } catch { try { key = entry.field("Key").value; } catch { continue; } }
                try { value = entry.field("value").value; } catch { try { value = entry.field("Value").value; } catch { continue; } }
                // heuristic: valid entry has non-default hashCode OR next-chain set
                if (hashCode === 0 && key === 0) continue;
                out.push(`[${shown}] ${stringifyValue(key)} → ${stringifyValue(value)}`);
                shown++;
            }
            if (total > shown) out.push(`… ${total - shown} more (raise limit)`);
            return out;
        });
    },

    readList(className: string, fieldName: string, limit = 50): Promise<string[]> {
        return inVm(() => {
            const inst = getCaptured(className);
            const listObj = inst.field(fieldName).value as Il2Cpp.Object;
            if (!listObj || (listObj.handle as any)?.isNull?.()) return ["(null)"];

            const out: string[] = [];
            out.push(`type: ${listObj.class.name}`);

            // Strategy 1 — read the internal backing array directly (most robust for List<T>).
            // List<T>._items is T[] of capacity size; List<T>._size is the real count.
            let items: Il2Cpp.Array<any> | null = null;
            let size = -1;
            try {
                const sz = listObj.tryField?.("_size")?.value;
                if (typeof sz === "number") size = sz;
            } catch {}
            try {
                const arr = listObj.tryField?.("_items")?.value;
                if (arr && typeof (arr as any).length === "number") items = arr as any;
            } catch {}

            // Strategy 2 — fallback: get_Count / get_Item
            if (size < 0) {
                try { size = listObj.method<number>("get_Count").invoke() as number; }
                catch (e) { out.push(`<err get_Count: ${e}>`); return out; }
            }

            out.push(`count: ${size}`);
            const max = Math.min(limit, size);

            if (items) {
                for (let i = 0; i < max; i++) {
                    try { out.push(`[${i}] ${stringifyValue(items.get(i))}`); }
                    catch (e) { out.push(`[${i}] <err: ${e}>`); }
                }
            } else {
                for (let i = 0; i < max; i++) {
                    try { out.push(`[${i}] ${stringifyValue(listObj.method("get_Item").invoke(i))}`); }
                    catch (e) { out.push(`[${i}] <err: ${e}>`); }
                }
            }

            if (size > max) out.push(`… ${size - max} more (raise limit)`);
            return out;
        });
    },
};

Il2Cpp.perform(() => {
    console.log("[rpc-agent] ready. Exposed: analyze, find, dumpClass, dumpStatics, hook, replaceNoop, patchStatic, forceReturn, callStatic");
    send({ type: "agent-ready" });
});
