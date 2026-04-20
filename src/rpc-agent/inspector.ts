// src/rpc-agent/inspector.ts
// Inspect a captured instance and return a tree-ready node description.
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";
import { getCapturedRaw, setCaptured } from "./registry";

type FieldNode = {
    name: string;
    typeName: string;
    kind: "primitive" | "reference" | "list" | "null" | "error";
    value?: string;          // stringified for primitives / null / error
    listCount?: number;      // for list kind
    listElemType?: string;   // for list kind
    referenceKey?: string;   // registry key if already captured
};

export function inspectInstance(key: string): Promise<{ className: string; handle: string; fields: FieldNode[] } | null> {
    return new Promise((resolve) => {
        Il2Cpp.perform(() => {
            const inst = getCapturedRaw(key);
            if (!inst) { resolve(null); return; }
            const out: FieldNode[] = [];
            for (const f of inst.class.fields) {
                if (f.isStatic) continue;
                const typeName = f.type.name;
                try {
                    const raw = inst.field(f.name).value;
                    if (raw == null || ((raw as any)?.handle?.isNull?.())) {
                        out.push({ name: f.name, typeName, kind: "null", value: "null" });
                        continue;
                    }
                    // Strings treated as primitives (stringifyValue handles them correctly).
                    if (typeName === "System.String") {
                        out.push({ name: f.name, typeName, kind: "primitive", value: stringifyValue(raw) });
                        continue;
                    }
                    // List<T> detection
                    if (/^System\.Collections\.Generic\.List`1/.test(typeName)) {
                        let count = -1;
                        const elemType = typeName.match(/<(.+)>$/)?.[1] ?? "?";
                        try {
                            const sz = (raw as any).tryField?.("_size")?.value;
                            count = typeof sz === "number" ? sz : (raw as Il2Cpp.Object).method<number>("get_Count").invoke() as number;
                        } catch { /* count stays -1 */ }
                        out.push({ name: f.name, typeName, kind: "list", listCount: count, listElemType: elemType });
                        continue;
                    }
                    // Reference type (object with class + handle). Guard via try/catch since
                    // some wrapped values (strings, enums) may not expose .class.
                    if (typeof raw === "object" && "handle" in (raw as any)) {
                        try {
                            const cls = (raw as Il2Cpp.Object).class;
                            if (cls && typeof cls.name === "string") {
                                out.push({ name: f.name, typeName, kind: "reference", value: `${cls.name}@${(raw as Il2Cpp.Object).handle}` });
                                continue;
                            }
                        } catch { /* fall through to primitive */ }
                    }
                    // Primitive
                    out.push({ name: f.name, typeName, kind: "primitive", value: stringifyValue(raw) });
                } catch (e) {
                    out.push({ name: f.name, typeName, kind: "error", value: `<err: ${String(e).slice(0, 60)}>` });
                }
            }
            resolve({ className: inst.class.name, handle: String(inst.handle), fields: out });
        });
    });
}

/** Capture the value of a reference-typed field under a new key so Inspector can dive into it. */
export function captureField(parentKey: string, fieldName: string, asKey: string): Promise<string> {
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            const parent = getCapturedRaw(parentKey);
            if (!parent) { reject(new Error(`no captured instance for ${parentKey}`)); return; }
            try {
                const val = parent.field(fieldName).value as Il2Cpp.Object;
                if (!val || (val as any).handle?.isNull?.()) { reject(new Error(`${fieldName} is null`)); return; }
                setCaptured(asKey, val);
                console.log(`[inspector] captured ${parentKey}.${fieldName} as "${asKey}" → ${val.class.name}@${val.handle}`);
                resolve(`${val.class.name}@${val.handle}`);
            } catch (e) { reject(e); }
        });
    });
}

/** Pull a slice of a captured List<T> as a flat array of {index, summary}. */
export function sliceList(key: string, fieldName: string, offset: number, limit: number): Promise<Array<{ index: number; summary: string; isReference: boolean }>> {
    const off = offset || 0;
    const lim = limit || 50;
    return new Promise((resolve, reject) => {
        Il2Cpp.perform(() => {
            const owner = getCapturedRaw(key);
            if (!owner) { reject(new Error(`no captured instance for ${key}`)); return; }
            try {
                const listObj = owner.field(fieldName).value as Il2Cpp.Object;
                if (!listObj || (listObj as any).handle?.isNull?.()) { resolve([]); return; }
                let items: Il2Cpp.Array<any> | null = null;
                let size = -1;
                try {
                    const sz = (listObj as any).tryField?.("_size")?.value;
                    if (typeof sz === "number") size = sz;
                } catch { /* ignore */ }
                try {
                    const arr = (listObj as any).tryField?.("_items")?.value;
                    if (arr && typeof (arr as any).length === "number") items = arr as any;
                } catch { /* ignore */ }
                if (size < 0) {
                    try { size = listObj.method<number>("get_Count").invoke() as number; } catch { size = 0; }
                }
                const end = Math.min(off + lim, size);
                const out: Array<{ index: number; summary: string; isReference: boolean }> = [];
                for (let i = off; i < end; i++) {
                    try {
                        const elem = items ? items.get(i) : listObj.method("get_Item").invoke(i);
                        if (elem == null || (elem as any)?.handle?.isNull?.()) {
                            out.push({ index: i, summary: "null", isReference: false });
                        } else if (typeof elem === "object" && "handle" in (elem as any)) {
                            out.push({ index: i, summary: `${(elem as Il2Cpp.Object).class.name}@${(elem as Il2Cpp.Object).handle}`, isReference: true });
                        } else {
                            out.push({ index: i, summary: stringifyValue(elem), isReference: false });
                        }
                    } catch (e) {
                        out.push({ index: i, summary: `<err: ${String(e).slice(0, 60)}>`, isReference: false });
                    }
                }
                resolve(out);
            } catch (e) { reject(e); }
        });
    });
}
