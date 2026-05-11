// Shared primitives for Dofus action RPCs (forge an outgoing packet, hook a
// response, send via ecx.xby). Anything truly specific to one action stays in
// its own file — this module only holds patterns repeated across actions.

import "frida-il2cpp-bridge";
import { findClass } from "../../../../lib";

export function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

/** Resolve the first live instance of `className`, or null. */
export function getLiveInstance(className: string): any | null {
    const klass = findClass(className);
    if (!klass) return null;
    const live = Il2Cpp.gc.choose(klass);
    return live.length > 0 ? live[0] : null;
}

/** Read an integer field, returning 0 on any failure. */
export function safeInt(obj: any, fieldName: string): number {
    try { return Number(obj.field(fieldName).value) || 0; } catch { return 0; }
}

/** Best-effort size for a List<T> (`_size`) or RepeatedField<T> (`count`). */
export function readListSize(list: any): number {
    try {
        return Number(
            list?.tryField?.("_size")?.value
            ?? list?.tryField?.("count")?.value
            ?? 0,
        );
    } catch { return 0; }
}

/** Best-effort backing array for a List<T> (`_items`) or RepeatedField<T> (`array`). */
export function readListItems(list: any): any | null {
    try {
        return list?.tryField?.("_items")?.value
            ?? list?.tryField?.("array")?.value
            ?? null;
    } catch { return null; }
}

/** Re-export `findClass` so action files don't need to thread the relative path. */
export { findClass };
