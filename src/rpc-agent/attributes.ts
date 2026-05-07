// RPC methods to read CustomAttributes via .NET reflection at runtime.
//
// Why : frida-il2cpp-bridge does not expose CustomAttribute information
// directly. Cpp2IL extracts them statically (offline), but that captures
// only what Cpp2IL knows about — it misses runtime-only registrations and
// can be confused by OPS-injected fake classes. Hooking `Type.GetCustomAttributes()`
// closes that gap: we read the same attributes the runtime sees.
//
// Notes:
//  - [Token], [Address], [FieldOffset] are Cpp2IL-INJECTED attributes (they
//    do not exist in the runtime); they only show up in the decompiled .cs
//    source. Don't expect to see them here.
//  - [DoNotRename], [Sentry.*], [GeneratedCode], [SerializableAttribute],
//    [ProtoContract], etc. ARE real runtime attributes and will be returned.
//  - GetCustomAttributes() can throw if an attribute references a missing
//    type — we always wrap in try/catch and degrade gracefully.

import "frida-il2cpp-bridge";
import { findClass, allClasses, fullClassName } from "../lib";

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

interface AttributeRecord {
    type: string;                  // attribute class FullName
    typeShort: string;             // attribute class short Name
    fields?: Record<string, string>; // public instance fields → stringified value
}

interface ClassAttributesResult {
    found: boolean;
    cls?: string;
    fullName?: string;
    attrs: AttributeRecord[];
    error?: string;
}

// Read the public instance fields of an attribute object — many attributes
// store their constructor args there (e.g. [Token(Token = "0x...")]).
function readAttributeFields(attr: any): Record<string, string> {
    const out: Record<string, string> = {};
    try {
        for (const f of (attr as any).class.fields) {
            if (f.isStatic) continue;
            try {
                const v = attr.field(f.name).value;
                if (v === null || v === undefined) continue;
                if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                    out[f.name] = String(v).slice(0, 200);
                } else if ((v as any)?.class) {
                    // boxed value, possibly an enum or a string-backed object
                    try {
                        const s = (v as any).method?.("ToString")?.invoke?.();
                        out[f.name] = safeStr(s).slice(0, 200);
                    } catch {
                        out[f.name] = (v as any).class.name;
                    }
                }
            } catch { /* skip field on error */ }
        }
    } catch {}
    return out;
}

function readAttributesArray(arr: any): AttributeRecord[] {
    const out: AttributeRecord[] = [];
    if (!arr) return out;
    let length = 0;
    try { length = (arr as any).length ?? 0; } catch {}
    for (let i = 0; i < length; i++) {
        try {
            const attr = (arr as any).get(i);
            if (!attr || !(attr as any).class) continue;
            const cls = (attr as any).class;
            const rec: AttributeRecord = {
                type: cls.fullName ?? cls.name,
                typeShort: cls.name,
                fields: readAttributeFields(attr),
            };
            // Drop empty fields object for compactness
            if (rec.fields && Object.keys(rec.fields).length === 0) delete rec.fields;
            out.push(rec);
        } catch { /* skip malformed entry */ }
    }
    return out;
}

/**
 * Read all CustomAttributes for a single class (by short name or full name).
 *
 * `inherit`: when true, includes attributes from parent classes (rarely useful
 * for OPS / Sentry detection, default false).
 */
export function getClassAttributes(className: string, inherit: boolean = false): Promise<ClassAttributesResult> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) return { found: false, attrs: [], error: "class not found" };
        const result: ClassAttributesResult = { found: true, cls: klass.name, fullName: fullClassName(klass), attrs: [] };
        try {
            const typeObj = (klass as any).type?.object;
            if (!typeObj) return { ...result, error: "type.object null" };
            // Type.GetCustomAttributes(Boolean inherit) → object[]
            const m = typeObj.method("GetCustomAttributes", 1);
            const arr = m.invoke(inherit);
            result.attrs = readAttributesArray(arr);
        } catch (e) {
            result.error = String(e).slice(0, 200);
        }
        return result;
    });
}

/**
 * Scan every class in every assembly and collect those whose attribute set
 * contains a name matching `pattern` (substring, case-insensitive). Returns
 * up to `limit` matches.
 *
 * Use case: "give me every class tagged with [DoNotRename]" → pattern = "DoNotRename"
 *           "give me every Sentry-related class" → pattern = "Sentry"
 *
 * This is expensive (one reflective call per class). Default limit is 5000
 * which finishes in a few seconds even on a 7600-class build. Set higher
 * only if needed.
 */
export function findClassesByAttribute(pattern: string, limit: number = 5000): Promise<{
    pattern: string;
    scanned: number;
    matched: number;
    elapsedMs: number;
    classes: Array<{ cls: string; fullName: string; attrs: AttributeRecord[] }>;
}> {
    return inVm(() => {
        const t0 = Date.now();
        const lower = pattern.toLowerCase();
        let scanned = 0;
        const out: Array<{ cls: string; fullName: string; attrs: AttributeRecord[] }> = [];
        for (const klass of allClasses()) {
            if (out.length >= limit) break;
            scanned++;
            try {
                const typeObj = (klass as any).type?.object;
                if (!typeObj) continue;
                const arr = typeObj.method("GetCustomAttributes", 1).invoke(false);
                const recs = readAttributesArray(arr);
                if (!recs.length) continue;
                const hits = recs.filter(r => r.type.toLowerCase().includes(lower) || r.typeShort.toLowerCase().includes(lower));
                if (hits.length) {
                    out.push({ cls: klass.name, fullName: fullClassName(klass), attrs: hits });
                }
            } catch { /* GetCustomAttributes can throw on classes referencing missing types */ }
        }
        return {
            pattern,
            scanned,
            matched: out.length,
            elapsedMs: Date.now() - t0,
            classes: out,
        };
    });
}

/**
 * Bulk dump: return the full attribute set for every class whose name matches
 * a pattern. Use this to compare runtime attributes against the offline
 * cpp2il-attribute-index.md, to spot runtime-only registrations.
 */
export function dumpClassAttributesBulk(classNames: string[]): Promise<{
    elapsedMs: number;
    results: Record<string, ClassAttributesResult>;
}> {
    return inVm(() => {
        const t0 = Date.now();
        const results: Record<string, ClassAttributesResult> = {};
        for (const name of classNames) {
            const klass = findClass(name);
            if (!klass) {
                results[name] = { found: false, attrs: [], error: "class not found" };
                continue;
            }
            try {
                const typeObj = (klass as any).type?.object;
                if (!typeObj) {
                    results[name] = { found: true, cls: klass.name, fullName: fullClassName(klass), attrs: [], error: "type.object null" };
                    continue;
                }
                const arr = typeObj.method("GetCustomAttributes", 1).invoke(false);
                results[name] = {
                    found: true,
                    cls: klass.name,
                    fullName: fullClassName(klass),
                    attrs: readAttributesArray(arr),
                };
            } catch (e) {
                results[name] = { found: true, cls: klass.name, fullName: fullClassName(klass), attrs: [], error: String(e).slice(0, 200) };
            }
        }
        return { elapsedMs: Date.now() - t0, results };
    });
}
