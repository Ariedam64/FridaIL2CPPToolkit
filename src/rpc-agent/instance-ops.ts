// RPC methods for live instance operations: capture, inspect, read, write, call, enumerate.
import "frida-il2cpp-bridge";
import { findClass, dumpFields, stringifyValue } from "../lib";
import { setCaptured, getCaptured, forEachCaptured, coerce } from "./registry";
import { notFoundClass, notFoundMethod, noLiveInstance } from "./errors";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

/**
 * Yield every field declared on `klass` AND inherited from its parent chain,
 * up to System.Object. Fixes the IL2CPP limitation that `klass.fields` returns
 * only declared (not inherited) fields.
 */
function* iterAllFields(klass: Il2Cpp.Class): Generator<Il2Cpp.Field> {
    let current: Il2Cpp.Class | null = klass;
    let depth = 0;
    while (current && depth < 20) {
        try {
            for (const f of current.fields) yield f;
        } catch { /* class-level access threw — stop walking */ break; }
        try {
            current = current.parent;
        } catch { current = null; }
        depth++;
    }
}

/**
 * Hook `tickMethod` once on `className` to steal the first `this` and store
 * it in the captured registry. Resolves to a summary like "Player@0x1234".
 */
export function capture(className: string, tickMethod: string, timeoutMs?: number, asKey?: string): Promise<string> {
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 10000;
    const key = asKey ?? className;
    return inVm(() => new Promise<string>((resolve, reject) => {
        const klass = findClass(className);
        if (!klass) return reject(notFoundClass(className));
        const method = klass.tryMethod(tickMethod);
        if (!method) return reject(notFoundMethod(className, tickMethod));
        if (method.isStatic) return reject(new Error(`${tickMethod} is static, cannot capture instance`));

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
                setCaptured(key, self);
                const summary = `${self.class.name}@${self.handle}`;
                console.log(`[capture] stored ${className} → ${summary} (key=${key})`);
                try { method.revert(); } catch {}
                resolve(summary);
            }
            return self.method(tickMethod).invoke(...args);
        };
        console.log(`[capture] armed on ${className}.${tickMethod}, waiting… (key=${key})`);
    }));
}

export function listCaptured(): Promise<string[]> {
    return inVm(() => {
        const out: string[] = [];
        forEachCaptured((inst, name) => out.push(`${name} → ${inst.class.name}@${inst.handle}`));
        return out;
    });
}

/**
 * List currently-alive instances of a class via the managed GC.
 * Works for most managed classes, but typically MISSES MonoBehaviours
 * (those need capture(cls, tickMethod)).
 */
export function listInstances(className: string, max = 20): Promise<string[]> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw notFoundClass(className);
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
}

/**
 * Pick one live instance via GC and store it in the captured registry.
 * Defaults to the first (index=0). Use listInstances() first if multiple.
 */
export function captureViaGC(className: string, index = 0, asKey?: string): Promise<string> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw notFoundClass(className);
        const instances = Il2Cpp.gc.choose(klass);
        if (!instances.length) throw noLiveInstance(className);
        const idx = index | 0;
        if (idx < 0 || idx >= instances.length) throw new Error(`index ${idx} out of range (${instances.length} alive)`);
        const inst = instances[idx];
        const key = asKey ?? className;
        setCaptured(key, inst);
        const summary = `${inst.class.name}@${inst.handle}`;
        console.log(`[capture] via GC: ${className} [${idx}] → ${summary} (key=${key})`);
        return summary;
    });
}

/**
 * Capture a reference-typed field of an already-captured instance.
 * Ex: captureFieldValue("openedItem", "<item>k__BackingField", "itemData")
 *     → stores openedItem.<item>BackingField under key "itemData".
 */
export function captureFieldValue(ownerKey: string, fieldName: string, asKey: string): Promise<string> {
    return inVm(() => {
        const owner = getCaptured(ownerKey);
        const value = owner.field(fieldName).value as Il2Cpp.Object;
        if (!value || (value.handle as any)?.isNull?.()) throw new Error(`${fieldName} is null`);
        setCaptured(asKey, value);
        const summary = `${value.class.name}@${value.handle}`;
        console.log(`[capture] ${ownerKey}.${fieldName} stored as "${asKey}" → ${summary}`);
        return summary;
    });
}

/**
 * Call a method on an already-captured instance and capture its (reference-typed) return value.
 * Ex: captureMethodReturn("openedItem", "get_item", [], "itemData")
 */
export function captureMethodReturn(ownerKey: string, methodName: string, args: any[] = [], asKey: string = ""): Promise<string> {
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
        setCaptured(key, result);
        const summary = `${result.class.name}@${result.handle}`;
        console.log(`[capture] ${ownerKey}.${methodName}() stored as "${key}" → ${summary}`);
        return summary;
    });
}

/**
 * Capture the Nth element of a List<T>-typed field on an already-captured instance.
 * Stores it in the registry under `asKey` (so you can later call read/write/callInstance on it).
 * Example: element 0 of AuctionHouseBuy.m_openedItems stored as key "openedItem0".
 */
export function captureListElement(
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
        setCaptured(asKey, elem);
        const summary = `${elem.class.name}@${elem.handle}`;
        console.log(`[capture] ${listClassName}.${listFieldName}[${index}] stored as "${asKey}" → ${summary}`);
        return summary;
    });
}

export function dumpInstance(className: string): Promise<void> {
    return inVm(() => dumpFields(getCaptured(className)));
}

export function dumpInstanceAsString(className: string): Promise<string> {
    return inVm(() => {
        const inst = getCaptured(className);
        const lines: string[] = [`# ${inst.class.name} (instance)`, ""];
        lines.push(`**Fields (instance)**`, "");
        for (const f of iterAllFields(inst.class)) {
            if (f.isStatic) continue;
            try {
                const v = stringifyValue(inst.field(f.name).value);
                lines.push(`- ${f.type.name} ${f.name} = ${v}`);
            } catch (e) {
                lines.push(`- ${f.type.name} ${f.name} = <err: ${e}>`);
            }
        }
        return lines.join("\n");
    });
}

export function readField(className: string, fieldName: string): Promise<string> {
    return inVm(() => stringifyValue(getCaptured(className).field(fieldName).value));
}

/** Dump all non-static fields of a captured instance, returning them as an array of strings. */
export function readAllFields(className: string): Promise<string[]> {
    return inVm(() => {
        const inst = getCaptured(className);
        const out: string[] = [];
        out.push(`class: ${inst.class.name}`);
        for (const f of iterAllFields(inst.class)) {
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
}

/**
 * Structured version of readAllFields — returns one entry per non-static field
 * with kind classification, preview, and rawValue for round-trip writes.
 * Used by the v1.4 Instances UI.
 */
export interface AgentFieldRead {
    name: string;
    typeName: string;
    kind: "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";
    preview: string;
    rawValue?: string | number | boolean;
    enumNumeric?: number;
    nestedClass?: string;
    arrayLength?: number;
    isWritable: boolean;
}

export function readAllFieldsStructured(className: string): Promise<AgentFieldRead[]> {
    return inVm(() => {
        const inst = getCaptured(className);
        const out: AgentFieldRead[] = [];
        for (const f of iterAllFields(inst.class)) {
            if (f.isStatic) continue;
            const name = f.name as string;
            const typeName = (f.type?.name ?? "?") as string;
            let isEnum = false;
            try { isEnum = (f.type as any)?.class?.parent?.name === "Enum"; } catch {}
            const isWritable = !((f as any).isLiteral === true);

            try {
                const v = inst.field(name).value;
                if (v === null || v === undefined) {
                    out.push({ name, typeName, kind: "null", preview: "null", isWritable });
                } else if (typeof v === "string") {
                    out.push({ name, typeName, kind: "string", preview: JSON.stringify(v), rawValue: v, isWritable });
                } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                    out.push({
                        name, typeName,
                        kind: isEnum ? "enum" : "scalar",
                        preview: String(v),
                        rawValue: typeof v === "bigint" ? (v as bigint).toString() : (v as number | boolean),
                        enumNumeric: isEnum && typeof v === "number" ? v : undefined,
                        isWritable,
                    });
                } else if (isEnum && (v as any).field) {
                    let underlying: number | undefined = undefined;
                    try { underlying = Number((v as any).field("value__").value); } catch {}
                    out.push({
                        name, typeName, kind: "enum",
                        preview: underlying !== undefined ? String(underlying) : String(v),
                        rawValue: underlying,
                        enumNumeric: underlying,
                        isWritable,
                    });
                } else if ((v as any).class) {
                    const cn = String((v as any).class.name);
                    if (cn.startsWith("RepeatedField") || cn.startsWith("List") || cn.includes("[]")) {
                        let count = 0;
                        try { count = Number((v as any).method("get_Count").invoke()); } catch {}
                        out.push({ name, typeName, kind: "array", preview: `[${count} items]`, arrayLength: count, isWritable: false });
                    } else {
                        out.push({ name, typeName, kind: "nested", preview: `→ ${cn}`, nestedClass: cn, isWritable: false });
                    }
                } else if (
                    /^System\.(Int|UInt)(16|32|64)$|^System\.(Single|Double|Byte|SByte)$/.test(typeName)
                ) {
                    // Frida wraps Int64/UInt64 (and other wide numerics under some configurations) as
                    // wrapper objects. Detect by typeName + rely on String(v).
                    const s = String(v);
                    out.push({
                        name, typeName,
                        kind: isEnum ? "enum" : "scalar",
                        preview: s,
                        rawValue: s,
                        isWritable,
                    });
                } else {
                    out.push({ name, typeName, kind: "unknown", preview: String(v), isWritable });
                }
            } catch (err) {
                const msg = String(err);
                if (msg.includes("access violation") && msg.includes("0x0")) {
                    out.push({ name, typeName, kind: "null", preview: "null", isWritable });
                } else {
                    out.push({ name, typeName, kind: "unknown", preview: `<err: ${msg.slice(0, 80)}>`, isWritable: false });
                }
            }
        }
        return out;
    });
}

/**
 * Preview an instance at `className`'s GC-enumerated `index` without storing
 * it in the registry. Returns up to `maxFields` non-static scalar/string/enum
 * fields. Used by the v1.4 instance picker to help users identify the right
 * instance among multiple live ones.
 */
export function previewInstance(
    className: string,
    index: number,
    maxFields: number = 10,
): Promise<AgentFieldRead[]> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw notFoundClass(className);
        const instances = Il2Cpp.gc.choose(klass);
        const idx = index | 0;
        if (idx < 0 || idx >= instances.length) {
            throw new Error(`index ${idx} out of range (${instances.length} alive)`);
        }
        const inst = instances[idx];
        const out: AgentFieldRead[] = [];
        for (const f of iterAllFields(inst.class)) {
            if (f.isStatic) continue;
            if (out.length >= maxFields) break;
            const name = f.name as string;
            const typeName = (f.type?.name ?? "?") as string;
            let isEnum = false;
            try { isEnum = (f.type as any)?.class?.parent?.name === "Enum"; } catch {}
            try {
                const v = inst.field(name).value;
                if (v === null || v === undefined) {
                    out.push({ name, typeName, kind: "null", preview: "null", isWritable: false });
                } else if (typeof v === "string") {
                    out.push({ name, typeName, kind: "string", preview: JSON.stringify(v), rawValue: v, isWritable: false });
                } else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") {
                    out.push({
                        name, typeName,
                        kind: isEnum ? "enum" : "scalar",
                        preview: String(v),
                        rawValue: typeof v === "bigint" ? (v as bigint).toString() : (v as number | boolean),
                        enumNumeric: isEnum && typeof v === "number" ? v : undefined,
                        isWritable: false,
                    });
                } else if (
                    /^System\.(Int|UInt)(16|32|64)$|^System\.(Single|Double|Byte|SByte)$/.test(typeName)
                ) {
                    // Frida wraps Int64/UInt64 (and other wide numerics under some configurations) as
                    // wrapper objects. Detect by typeName + rely on String(v).
                    const s = String(v);
                    out.push({
                        name, typeName,
                        kind: isEnum ? "enum" : "scalar",
                        preview: s,
                        rawValue: s,
                        isWritable: false,
                    });
                }
                // Skip nested/array kinds for preview — not useful for value-recognition.
            } catch {
                // Skip fields that throw — keep preview compact.
            }
        }
        return out;
    });
}

export interface ScanMatch {
    className: string;
    handle: string;
    fieldName: string;
    fieldType: string;
    fieldValue: string;
}

export interface ValueScanOptions {
    classFilter?: string;
    maxMatches?: number;
    skipFramework?: boolean;
    /** Type names to include in the scan; if omitted, narrows by value type. */
    typeFilter?: string[];
}

function valueMatches(actual: unknown, expected: string | number | boolean): boolean {
    if (typeof expected === "boolean") {
        if (typeof actual === "boolean") return actual === expected;
        // Allow "true"/"false"/0/1 stringification fallback below
    }
    if (actual === null || actual === undefined) return false;

    const expectedStr = String(expected);

    if (typeof actual === "number") {
        const e = Number(expected);
        return !Number.isNaN(e) && actual === e;
    }
    if (typeof actual === "bigint") {
        return actual.toString() === expectedStr;
    }
    if (typeof actual === "string") {
        return actual === expectedStr;
    }
    if (typeof actual === "boolean") {
        return String(actual) === expectedStr;
    }

    // Catch-all: Frida Int64/UInt64 wrappers and anything with a sensible toString.
    // Compares the decimal-string representation.
    try {
        const s = String(actual);
        return s === expectedStr;
    } catch {
        return false;
    }
}


function fieldTypeMatchesValue(typeName: string, value: string | number | boolean): boolean {
    if (typeof value === "boolean") return typeName === "System.Boolean";
    if (typeof value === "number" || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))) {
        const isFloat = typeof value === "number"
            ? !Number.isInteger(value)
            : value.includes(".");
        if (isFloat) {
            return /^System\.(Single|Double)$/.test(typeName);
        }
        // Integer-like: stick to common int widths. Skip Byte/SByte (rarely useful for values like 23541).
        return /^System\.(Int16|Int32|Int64|UInt16|UInt32|UInt64)$/.test(typeName);
    }
    return typeName === "System.String";
}

function isFrameworkClass(className: string): boolean {
    return /^(System\.|UnityEngine\.|Unity\.|Mono\.|Microsoft\.|netstandard\.|mscorlib\.)/.test(className);
}

export function valueScan(
    value: string | number | boolean,
    options: ValueScanOptions = {},
): Promise<ScanMatch[]> {
    return inVm(() => {
        const maxMatches = options.maxMatches ?? 500;
        const skipFramework = options.skipFramework !== false;
        const classRegex = options.classFilter ? new RegExp(options.classFilter, "i") : null;
        const typeFilter = options.typeFilter && options.typeFilter.length > 0
            ? new Set(options.typeFilter)
            : null;
        const matches: ScanMatch[] = [];

        send({ type: "scan-progress", scanned: 0, total: 0, found: 0, phase: "snapshot" });

        // gc.choose on System.Object enumerates the entire C# managed heap.
        // MemorySnapshot only captures Unity-side objects and misses domain C# classes.
        let rootKlass: Il2Cpp.Class;
        try {
            rootKlass = Il2Cpp.corlib.class("System.Object");
        } catch (err) {
            send({ type: "scan-progress", scanned: 0, total: 0, found: 0, phase: "done", done: true });
            throw new Error(`unable to resolve System.Object: ${err instanceof Error ? err.message : String(err)}`);
        }
        const allObjects = Il2Cpp.gc.choose(rootKlass);
        const total = allObjects.length;
        send({ type: "scan-progress", scanned: 0, total, found: 0, phase: "scanning" });

        // Cache class candidate fields. Map of className -> field list (or null when class has none).
        const classFieldsCache = new Map<string, Array<{ name: string; typeName: string }> | null>();

        const PROGRESS_EVERY = 5000;
        for (let i = 0; i < total; i++) {
            if (i % PROGRESS_EVERY === 0) {
                send({ type: "scan-progress", scanned: i, total, found: matches.length, phase: "scanning" });
            }
            if (matches.length >= maxMatches) break;

            const obj = allObjects[i];
            let klass: Il2Cpp.Class;
            try { klass = obj.class; } catch { continue; }
            const cn = klass.name;

            if (skipFramework && isFrameworkClass(cn)) continue;
            if (classRegex && !classRegex.test(cn)) continue;

            // Compute / cache candidate fields for this class (walks parent chain via iterAllFields).
            let candidateFields = classFieldsCache.get(cn);
            if (candidateFields === undefined) {
                candidateFields = [];
                try {
                    for (const f of iterAllFields(klass)) {
                        if (f.isStatic) continue;
                        const typeName = (f.type?.name ?? "") as string;
                        if (typeFilter) {
                            if (!typeFilter.has(typeName)) continue;
                        } else {
                            if (!fieldTypeMatchesValue(typeName, value)) continue;
                        }
                        candidateFields.push({ name: f.name, typeName });
                    }
                } catch {
                    candidateFields = null;
                }
                classFieldsCache.set(cn, candidateFields);
            }
            if (!candidateFields || candidateFields.length === 0) continue;

            for (const cf of candidateFields) {
                try {
                    const v = obj.field(cf.name).value;
                    if (valueMatches(v, value)) {
                        matches.push({
                            className: cn,
                            handle: String(obj.handle),
                            fieldName: cf.name,
                            fieldType: cf.typeName,
                            fieldValue: String(v),
                        });
                        if (matches.length >= maxMatches) break;
                    }
                } catch { /* skip unreadable */ }
            }
        }

        send({ type: "scan-progress", scanned: total, total, found: matches.length, phase: "done", done: true });
        return matches;
    });
}

/**
 * Refine an existing scan by re-reading each match's CURRENT value and
 * filtering to those equal to `newValue`. Mimics Cheat Engine's "Next Scan".
 */
export function valueScanFilter(
    prevMatches: ScanMatch[],
    newValue: string | number | boolean,
): Promise<ScanMatch[]> {
    return inVm(() => {
        const out: ScanMatch[] = [];
        const klassCache = new Map<string, Il2Cpp.Class>();

        for (const m of prevMatches) {
            let klass = klassCache.get(m.className);
            if (!klass) {
                try {
                    for (const asm of Il2Cpp.domain.assemblies) {
                        for (const k of asm.image.classes) {
                            if (k.name === m.className) { klass = k; break; }
                        }
                        if (klass) break;
                    }
                } catch {}
                if (klass) klassCache.set(m.className, klass);
            }
            if (!klass) continue;

            // Find instance by handle in live set
            let inst: Il2Cpp.Object | null = null;
            try {
                const instances = Il2Cpp.gc.choose(klass);
                for (const i of instances) {
                    if (String(i.handle) === m.handle) { inst = i; break; }
                }
            } catch {}
            if (!inst) continue;

            try {
                const v = inst.field(m.fieldName).value;
                if (valueMatches(v, newValue)) {
                    out.push({ ...m, fieldValue: String(v) });
                }
            } catch {}
        }
        return out;
    });
}

/**
 * Capture an instance by its live handle (from a scan match), storing under asKey.
 * Returns "ClassName@handle" summary or throws if the instance is no longer alive.
 */
export function captureByHandle(className: string, handle: string, asKey: string): Promise<string> {
    return inVm(() => {
        let klass: Il2Cpp.Class | null = null;
        for (const asm of Il2Cpp.domain.assemblies) {
            for (const k of asm.image.classes) {
                if (k.name === className) { klass = k; break; }
            }
            if (klass) break;
        }
        if (!klass) throw new Error(`class not found: ${className}`);
        const instances = Il2Cpp.gc.choose(klass);
        const inst = instances.find((i) => String(i.handle) === handle);
        if (!inst) throw new Error(`instance ${className}@${handle} no longer alive`);
        setCaptured(asKey, inst);
        const summary = `${inst.class.name}@${inst.handle}`;
        console.log(`[capture] by handle: ${className}@${handle} stored as "${asKey}" → ${summary}`);
        return summary;
    });
}

export function writeField(className: string, fieldName: string, value: any): Promise<string> {
    return inVm(() => {
        const inst = getCaptured(className);
        const field = inst.field(fieldName);
        field.value = coerce(value, field.type.name) as any;
        const after = stringifyValue(field.value);
        console.log(`[patch] ${className}.${fieldName} = ${after}`);
        return after;
    });
}

export function callInstance(className: string, methodName: string, args: any[] = []): Promise<string> {
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
}

/**
 * Read elements of a List<T>-typed field on a captured instance.
 * - For primitive T (Int32, UInt32, Int64, String…): returns values stringified.
 * - For reference T: returns "ClassName@handle".
 * Handles null lists and shows truncation info.
 */
export function readList(className: string, fieldName: string, limit = 50): Promise<string[]> {
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
}

/**
 * Enumerate a List<T>-typed field and call the given methods on each element.
 * Returns one summary line per element: `[i] Class  method1=val  method2=val …`.
 */
export function enumerateList(
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
}

/**
 * Read entries of a Dictionary<K,V>-typed field on a captured instance.
 * Iterates the internal `_entries` array (bypasses generic get_Item, which can crash).
 * Returns "[i] key → value" lines. Caps at `limit` real entries.
 */
export function readDict(className: string, fieldName: string, limit = 50): Promise<string[]> {
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
}

/**
 * Look up a single value by key in a Dictionary<K,V> field.
 * Uses the internal `_entries` array (safe for primitive-keyed dicts).
 * `key` is matched against entry.key via strict equality on the stringified value.
 */
export function dictGet(className: string, fieldName: string, key: any): Promise<string> {
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
}
