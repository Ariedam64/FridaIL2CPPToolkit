// RPC methods to dump the runtime Protobuf message router (`gbe` singleton).
//
// `gbe` holds 4 dispatchers (dqil/dqim/dqin/dqio in the current build), each
// of which wraps a `Dictionary<System.Type, gab<X>>` where the key is the
// runtime CLR Type of an incoming protobuf message. CLR Type names are NOT
// touched by OPS (System.Type.FullName returns the actual obfuscated class
// name in clean form), so dumping these dictionaries yields the precise
// `MessageClass → HandlerClass.HandlerMethod` mapping.
//
// Until now this had been documented but never executed at runtime — all
// handler attribution went through static structural inference. This RPC
// closes that loop.

import "frida-il2cpp-bridge";
import { findClass } from "../lib";
import { getSingleton } from "./singleton-cache";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

function safeStr(v: any): string {
    if (v === null || v === undefined) return "";
    try {
        if (typeof v === "string") return v;
        if (typeof (v as any).content === "string") return (v as any).content;
        return String(v).replace(/^"|"$/g, "");
    } catch { return "<?>"; }
}

interface HandlerInfo {
    cls: string;                  // class of the gab<X> implementation (or wrapper)
    delegate?: {
        target?: { cls: string; handle: string };
        method?: string;          // System.Reflection.MethodInfo.Name (often obfuscated)
        invocationCount?: number;
    };
    fields?: Array<{ name: string; type: string; preview: string }>;
}

interface RouterEntry {
    typeName: string;             // System.Type.FullName — clean CLR name
    typeShortName: string;        // System.Type.Name — short obfuscated class
    handler?: HandlerInfo;
}

interface DispatcherDump {
    fieldName: string;            // gbe field name (dqil/dqim/dqin/dqio)
    fieldType: string;            // declared type (gaz/gba/gbb/gbc)
    runtimeCls: string;           // actual class on the value
    dictFieldName?: string;       // field that pointed to the Dictionary
    dictType?: string;            // e.g. "Dictionary<Type, gab<gav>>"
    entryCount: number;
    entries: RouterEntry[];
}

interface GbeRouterDump {
    found: boolean;
    instanceHandle?: string;
    instanceCls?: string;
    dispatchers: DispatcherDump[];
    notes: string[];
}

// Probe a value for a usable class object. Defensive against zombie handles
// and primitive values: any throw → no class.
function tryClassName(v: any): string | null {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === "number" || t === "boolean" || t === "string" || t === "bigint") return null;
    try {
        const c = (v as any).class;
        if (!c) return null;
        return String(c.name);
    } catch { return null; }
}

// Walk an arbitrary object's fields, find every reference whose runtime class
// looks like a Dictionary<,>. We don't trust the declared type (it may be an
// interface or an obfuscated wrapper) — we look at the actual instance.
function findDictionaryFields(obj: any): Array<{ name: string; type: string; value: any }> {
    const out: Array<{ name: string; type: string; value: any }> = [];
    if (!obj) return out;
    let fields: any[] = [];
    try { fields = (obj as any).class.fields; } catch { return out; }
    for (const f of fields) {
        if (f.isStatic) continue;
        let v: any;
        try { v = obj.field(f.name).value; } catch { continue; }
        const cls = tryClassName(v);
        if (!cls) continue;
        if (cls.startsWith("Dictionary") || cls === "Dictionary`2") {
            out.push({ name: f.name, type: f.type.name, value: v });
        }
    }
    return out;
}

// Read a Dictionary<Type, V> as an array of (typeName, value) pairs. The .NET
// Dictionary internal layout exposes `_entries: Entry[]` and `_count: int`;
// each Entry has `hashCode`, `key`, `value`, `next`. Negative hashCode means
// the slot is in the free list — skip.
function readTypeKeyedDictionary(dict: any, max: number): Array<{ keyType: any; value: any }> {
    const out: Array<{ keyType: any; value: any }> = [];
    if (!dict) return out;
    let entries: any, count = 0;
    try { entries = dict.field("_entries").value; } catch {}
    try { count = Number(dict.field("_count").value); } catch {}
    if (!entries || !count) {
        // Fallback for older Dictionary layouts
        try { entries = dict.field("entries").value; } catch {}
        try { count = Number(dict.field("count").value); } catch {}
    }
    if (!entries || !count) return out;
    const limit = Math.min(count, max);
    for (let i = 0; i < limit; i++) {
        try {
            const e = entries.get(i);
            let hc = 0;
            try { hc = Number(e.field("hashCode").value); } catch {}
            if (hc < 0) continue;
            const key = e.field("key").value;
            const value = e.field("value").value;
            if (!key) continue;
            out.push({ keyType: key, value });
        } catch { /* skip malformed slot */ }
    }
    return out;
}

// Pull `FullName` and `Name` off a `System.Type` object. Both are strings
// (System.RuntimeType properties).
function readTypeNames(typeObj: any): { fullName: string; shortName: string } {
    let fullName = "?", shortName = "?";
    try { fullName = safeStr(typeObj.method("get_FullName").invoke()); } catch {}
    try { shortName = safeStr(typeObj.method("get_Name").invoke()); } catch {}
    return { fullName, shortName };
}

// gab<X> is an interface. Its concrete implementation typically wraps a
// `System.Delegate` (or several). Dig for it.
function describeHandler(handler: any): HandlerInfo | undefined {
    const cls = tryClassName(handler);
    if (!cls) return undefined;
    const info: HandlerInfo = { cls, fields: [] };

    let fields: any[] = [];
    try { fields = (handler as any).class.fields; } catch { return info; }
    for (const f of fields) {
        if (f.isStatic) continue;
        let v: any;
        try { v = handler.field(f.name).value; } catch { continue; }
        const fieldType = f.type.name;
        const entry: { name: string; type: string; preview: string } = {
            name: f.name, type: fieldType, preview: "",
        };

        if (v === null || v === undefined) {
            entry.preview = "null";
        } else if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
            entry.preview = String(v).slice(0, 80);
        } else {
            const vcls = (v as any).class?.name ?? "";
            entry.preview = vcls;
            // System.MulticastDelegate or any subclass of System.Delegate has
            // _target (instance) and _methodPtr (or _invocationList for
            // multicasts). The simplest and most informative is to print
            // _target's class.
            const isDelegate = fieldType === "System.Delegate"
                || fieldType === "System.MulticastDelegate"
                || vcls.endsWith("Delegate")
                || vcls === "MulticastDelegate";
            if (isDelegate && !info.delegate) {
                info.delegate = {};
                try {
                    const target = v.field("_target").value;
                    if (target && (target as any).class) {
                        info.delegate.target = {
                            cls: (target as any).class.name,
                            handle: String((target as any).handle),
                        };
                    }
                } catch {}
                try {
                    // Method may be a lazy MethodInfo — use Method.get_Method() if exposed.
                    const mi = v.tryMethod?.("get_Method")?.invoke?.();
                    if (mi) {
                        try {
                            info.delegate.method = safeStr(mi.method("get_Name").invoke());
                        } catch {}
                    }
                } catch {}
                try {
                    const inv = v.field("_invocationCount")?.value;
                    if (typeof inv === "number" || typeof inv === "bigint") info.delegate.invocationCount = Number(inv);
                } catch {}
            }
        }
        info.fields!.push(entry);
    }
    return info;
}

/**
 * Find the live `gbe` singleton, walk its 4 dispatcher fields, and dump
 * every routing entry with its CLR type name and handler info.
 *
 * `dispatcherFields` lets you override the field names if Ankama rotates
 * them in a future build. By default we read whatever fields hold non-null
 * objects — same fallback strategy as findDictionaryFields.
 */
export function dumpGbeRouter(maxEntriesPerDict: number = 2000): Promise<GbeRouterDump> {
    return inVm(() => {
        const result: GbeRouterDump = {
            found: false,
            dispatchers: [],
            notes: [],
        };
        const klass = findClass("gbe");
        if (!klass) {
            result.notes.push("class 'gbe' not found");
            return result;
        }

        const inst = getSingleton(klass);
        if (!inst) {
            result.notes.push("no live 'gbe' instance (Il2Cpp.gc.choose returned empty)");
            return result;
        }
        result.found = true;
        result.instanceCls = klass.name;
        try { result.instanceHandle = String((inst as any).handle); } catch {}

        // Walk gbe's instance fields. We expect 4 dispatchers (gaz/gba/gbb/gbc)
        // each holding a Dictionary internally. We don't hardcode names — we
        // walk each non-primitive instance field, then look INSIDE it for a
        // Dictionary<,> field.
        for (const f of klass.fields) {
            if (f.isStatic) continue;
            let dispatcher: any;
            try { dispatcher = (inst as any).field(f.name).value; } catch { continue; }
            const dispCls = tryClassName(dispatcher);
            if (!dispCls) continue;
            // Skip primitives, value types (Queue, ints, bools).
            if (dispCls.startsWith("Queue") || dispCls === "Boolean" || dispCls === "Int32") continue;
            // Skip the obvious non-dispatchers — they typically have very few
            // fields. Dispatchers carry an inner Dictionary.
            const dicts = findDictionaryFields(dispatcher);
            // Some dispatchers have the dict on a parent class (gay<,>): walk
            // the parent chain too if no direct hit.
            let walked: typeof dicts = [];
            if (dicts.length) {
                walked = dicts;
            } else {
                let cur = (dispatcher as any).class.parent;
                let target: any = dispatcher;
                while (cur && !walked.length) {
                    // Look for fields declared on parent class. frida-il2cpp-bridge
                    // surfaces all fields (declared + inherited) via `class.fields`,
                    // so this branch is mostly defensive.
                    walked = findDictionaryFields(target);
                    cur = cur.parent;
                }
            }

            if (!walked.length) continue;

            // Pick the dict whose key type is `System.Type` — that's the
            // routing dict. Other dicts in the same wrapper (e.g. lookup of
            // (Delegate, Type) → gag in gai<>) are noise for our purpose.
            const dump: DispatcherDump = {
                fieldName: f.name,
                fieldType: f.type.name,
                runtimeCls: dispCls,
                entryCount: 0,
                entries: [],
            };

            for (const d of walked) {
                const sample = readTypeKeyedDictionary(d.value, 5);
                // Detect Type-keyed by attempting to read a key's get_FullName()
                let isTypeKeyed = false;
                if (sample.length) {
                    try {
                        const t = sample[0].keyType;
                        if (t && (t as any).method) {
                            const fn = safeStr(t.method("get_FullName").invoke());
                            if (fn) isTypeKeyed = true;
                        }
                    } catch {}
                }
                if (!isTypeKeyed) continue;

                dump.dictFieldName = d.name;
                dump.dictType = d.type;
                const all = readTypeKeyedDictionary(d.value, maxEntriesPerDict);
                dump.entryCount = all.length;
                for (const { keyType, value } of all) {
                    const { fullName, shortName } = readTypeNames(keyType);
                    const handler = describeHandler(value);
                    dump.entries.push({ typeName: fullName, typeShortName: shortName, handler });
                }
                break; // first Type-keyed dict wins
            }

            if (dump.entryCount > 0) result.dispatchers.push(dump);
        }

        result.notes.push(`scanned gbe singleton, found ${result.dispatchers.length} dispatchers with Type-keyed dicts`);
        const total = result.dispatchers.reduce((a, d) => a + d.entryCount, 0);
        result.notes.push(`total routing entries: ${total}`);
        return result;
    });
}
