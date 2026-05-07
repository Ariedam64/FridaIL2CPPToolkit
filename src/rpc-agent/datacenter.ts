// RPC methods to enumerate and dump Core.DataCenter.Metadata.* repositories.
//
// The DataCenter assembly is plain text (not obfuscated by OPS), with 53
// namespaces × ~10 classes each = ~500 data types covering Items, Spells,
// Monsters, Quests, NPCs, Maps, Effects, Jobs, etc. Each domain has a
// `XxxDataRoot` class that holds the loaded collection. Hooking in here gives
// us the full static game data in one pass — useful both as a content mirror
// and as a semantic anchor for the obfuscated parts of Core (e.g. when an
// obfuscated message field's value is in [0..560], it's likely a cellId).

import "frida-il2cpp-bridge";
import { findClass, allClasses } from "../lib";
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

interface DataRootSummary {
    cls: string;                       // e.g. "ItemsDataRoot"
    fullName: string;                  // e.g. "Core.DataCenter.Metadata.Item.ItemsDataRoot"
    instanceCount: number;             // alive instances via Il2Cpp.gc.choose
    domainType?: string;               // inferred type of the held data (e.g. "ItemData") — best-effort
    getterMethod?: string;             // e.g. "GetItemById" if found
    listFields?: string[];             // candidate fields holding the collection
    sampleItemFields?: string[];       // fields of the first item, to know what's queryable
    error?: string;
}

/**
 * Enumerate every class whose short name ends with `DataRoot` and describe its
 * STATIC shape (getter signature + collection fields). Does NOT call
 * `Il2Cpp.gc.choose`, which walks the entire managed heap and would freeze
 * the game when called once per DataRoot. Use `dumpDataRoot` to get runtime
 * data for a SPECIFIC root — it pays the gc.choose cost just once.
 */
export function listDataRoots(): Promise<DataRootSummary[]> {
    return inVm(() => {
        const out: DataRootSummary[] = [];
        for (const klass of allClasses()) {
            if (!klass.name.endsWith("DataRoot")) continue;
            const summary: DataRootSummary = {
                cls: klass.name,
                fullName: (klass as any).fullName ?? klass.name,
                instanceCount: -1,                // -1 = not probed (avoid gc.choose flood)
            };
            try {
                let getter: Il2Cpp.Method<any> | null = null;
                for (const m of klass.methods) {
                    if (m.name.startsWith("Get") && m.name.endsWith("ById") && m.parameters.length === 1) {
                        getter = m as Il2Cpp.Method<any>;
                        break;
                    }
                }
                if (getter) {
                    summary.getterMethod = getter.name;
                    summary.domainType = getter.returnType.name;
                }

                const lf: string[] = [];
                for (const f of klass.fields) {
                    if (f.isStatic) continue;
                    const t = f.type.name;
                    if (t.startsWith("System.Collections.Generic.Dictionary") ||
                        t.startsWith("System.Collections.Generic.List") ||
                        t.includes("[]")) {
                        lf.push(`${f.name}: ${t}`);
                    }
                }
                summary.listFields = lf;
            } catch (e) {
                summary.error = String(e).slice(0, 200);
            }
            out.push(summary);
        }
        out.sort((a, b) => a.cls.localeCompare(b.cls));
        return out;
    });
}

interface DumpedItem {
    id?: number;
    fields: Record<string, any>;
}

interface DataRootDump {
    cls: string;
    fullName: string;
    found: boolean;
    error?: string;
    sourceMethod?: string;             // how items were enumerated
    requestedMax: number;
    extractedCount: number;
    items: DumpedItem[];
}

function readScalar(v: any): any {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === "number" || t === "boolean" || t === "bigint") return t === "bigint" ? String(v) : v;
    if (t === "string") return v;
    // Il2Cpp string instance
    if (typeof (v as any).content === "string") return (v as any).content;
    return null;
}

function readItemFields(item: any, depth: number = 1): Record<string, any> {
    const out: Record<string, any> = {};
    if (!item || !(item as any).class) return out;
    try {
        for (const f of (item as any).class.fields) {
            if (f.isStatic) continue;
            try {
                const v = item.field(f.name).value;
                const scalar = readScalar(v);
                if (scalar !== null) {
                    out[f.name] = scalar;
                    continue;
                }
                // Lists / arrays: just record the count to keep output compact.
                const cls = (v as any)?.class?.name as string | undefined;
                if (cls && (cls.startsWith("List") || cls.startsWith("RepeatedField") || (v as any).length !== undefined)) {
                    let count = 0;
                    try { count = Number((v as any).method?.("get_Count")?.invoke?.()) ?? 0; } catch {
                        try { count = (v as any).length ?? 0; } catch {}
                    }
                    out[f.name] = `[${count}] (${cls ?? "list"})`;
                    continue;
                }
                if (cls) {
                    out[f.name] = `<${cls}>`;
                }
            } catch { /* skip field on error */ }
        }
    } catch {}
    return out;
}

/**
 * Dump items from a single DataRoot. Two strategies:
 *  1) If the root has a `GetXxxById(int)` getter, enumerate ids 0..max and
 *     skip nulls. This works for sequential int-keyed roots.
 *  2) Else, find a Dictionary or List field on the root and walk it.
 *
 * Most Dofus DataRoots support strategy 1. `idStart`/`idEnd` lets you scope.
 */
export function dumpDataRoot(rootClassName: string, idStart: number = 0, idEnd: number = 5000): Promise<DataRootDump> {
    return inVm(() => {
        const out: DataRootDump = {
            cls: rootClassName,
            fullName: rootClassName,
            found: false,
            requestedMax: idEnd - idStart + 1,
            extractedCount: 0,
            items: [],
        };
        const klass = findClass(rootClassName);
        if (!klass) { out.error = "class not found"; return out; }
        out.fullName = (klass as any).fullName ?? klass.name;

        const root = getSingleton(klass) as any;
        if (!root) { out.error = "no live instance"; return out; }
        out.found = true;

        // Strategy 1: GetXxxById(int)
        let getter: Il2Cpp.Method<any> | null = null;
        for (const m of klass.methods) {
            if (m.name.startsWith("Get") && m.name.endsWith("ById") && m.parameters.length === 1) {
                getter = m as Il2Cpp.Method<any>;
                break;
            }
        }
        if (getter) {
            out.sourceMethod = getter.name;
            for (let id = idStart; id <= idEnd; id++) {
                try {
                    const item = root.method(getter.name).invoke(id);
                    if (!item) continue;
                    if ((item as any).handle && String((item as any).handle) === "0x0") continue;
                    out.items.push({ id, fields: readItemFields(item, 1) });
                    out.extractedCount++;
                } catch { /* skip ids that throw */ }
            }
            return out;
        }

        // Strategy 2: walk first List<>/Dictionary<,> field
        for (const f of klass.fields) {
            if (f.isStatic) continue;
            let v: any;
            try { v = root.field(f.name).value; } catch { continue; }
            if (!v) continue;
            const cls = (v as any)?.class?.name;
            if (!cls) continue;
            if (cls.startsWith("List")) {
                out.sourceMethod = `field:${f.name}`;
                try {
                    const n = Number((v as any).method("get_Count").invoke());
                    const limit = Math.min(n, idEnd - idStart + 1);
                    for (let i = idStart; i < idStart + limit; i++) {
                        try {
                            const item = (v as any).method("get_Item").invoke(i);
                            if (!item) continue;
                            out.items.push({ fields: readItemFields(item, 1) });
                            out.extractedCount++;
                        } catch { /* skip */ }
                    }
                } catch (e) { out.error = String(e).slice(0, 200); }
                return out;
            }
            if (cls.startsWith("Dictionary")) {
                out.sourceMethod = `field:${f.name}`;
                try {
                    let entries: any, count = 0;
                    try { entries = (v as any).field("_entries").value; } catch {}
                    try { count = Number((v as any).field("_count").value); } catch {}
                    const limit = Math.min(count, idEnd - idStart + 1);
                    for (let i = 0; i < limit; i++) {
                        try {
                            const e = (entries as any).get(i);
                            let hc = 0; try { hc = Number(e.field("hashCode").value); } catch {}
                            if (hc < 0) continue;
                            const key = e.field("key").value;
                            const value = e.field("value").value;
                            if (!value) continue;
                            const item: DumpedItem = { fields: readItemFields(value, 1) };
                            const k = readScalar(key);
                            if (typeof k === "number") item.id = k;
                            out.items.push(item);
                            out.extractedCount++;
                        } catch {}
                    }
                } catch (e) { out.error = String(e).slice(0, 200); }
                return out;
            }
        }

        out.error = "no getter or collection field found";
        return out;
    });
}
