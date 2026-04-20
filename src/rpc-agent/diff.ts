// src/rpc-agent/diff.ts
import "frida-il2cpp-bridge";
import { stringifyValue } from "../lib";
import { getCapturedRaw } from "./registry";

/** Snapshot all non-static fields of a captured instance as a flat string-map. */
export function snapshotInstance(key: string): Promise<{ className: string; fields: Record<string, string> } | null> {
    return new Promise((resolve) => {
        Il2Cpp.perform(() => {
            const inst = getCapturedRaw(key);
            if (!inst) { resolve(null); return; }
            const fields: Record<string, string> = {};
            for (const f of inst.class.fields) {
                if (f.isStatic) continue;
                try {
                    fields[f.name] = stringifyValue(inst.field(f.name).value);
                } catch (e) {
                    fields[f.name] = `<err: ${String(e).slice(0, 60)}>`;
                }
            }
            resolve({ className: inst.class.name, fields });
        });
    });
}
