// Shared primitives for Dofus action RPCs (forge an outgoing packet, hook a
// response, send via ecx.xby). Anything truly specific to one action stays in
// its own file — this module only holds patterns repeated across actions.

import "frida-il2cpp-bridge";
import { findClass } from "../../../../lib";

export function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

/** Cache for singleton live instances. Keyed by className. `Il2Cpp.gc.choose`
 *  walks the entire IL2CPP heap (~300-500ms on a fully loaded Dofus client) so
 *  re-resolving on every RPC turns each autopilot send into a multi-100ms stall.
 *  Singletons like Network.OutgoingDispatcher persist for the lifetime of the
 *  game session, so caching once and reusing is safe. */
const liveInstanceCache = new Map<string, any>();

/** Resolve the first live instance of `className`, or null. Caches the result
 *  for the script lifetime — the Frida agent re-attach starts a fresh cache. */
export function getLiveInstance(className: string): any | null {
    const cached = liveInstanceCache.get(className);
    if (cached) return cached;
    const klass = findClass(className);
    if (!klass) return null;
    const live = Il2Cpp.gc.choose(klass);
    if (live.length === 0) return null;
    liveInstanceCache.set(className, live[0]);
    return live[0];
}

/** Clear the live-instance cache. Use if you suspect a cached singleton has
 *  been destroyed (rare — would mean the game disconnected). */
export function clearLiveInstanceCache(): void {
    liveInstanceCache.clear();
}

export interface WarmupResult {
    ok: boolean;
    warmed: string[];
    failed: string[];
    /** Per-class lookup duration (ms). Each entry includes the `gc.choose` walk. */
    timings: Record<string, number>;
}

/** Pre-resolve and cache live instances of singletons the autopilot/movement/
 *  change-map paths rely on, so their first RPC after attach doesn't pay the
 *  ~350ms `gc.choose` heap-scan. Idempotent — already-cached entries are
 *  re-recorded as 0ms hits. */
export function warmupLiveInstance(classNames: string[]): Promise<WarmupResult> {
    return inVm(() => {
        const warmed: string[] = [];
        const failed: string[] = [];
        const timings: Record<string, number> = {};
        for (const name of classNames) {
            const t0 = Date.now();
            const inst = getLiveInstance(name);
            timings[name] = Date.now() - t0;
            if (inst) warmed.push(name);
            else failed.push(name);
        }
        return { ok: failed.length === 0, warmed, failed, timings };
    });
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
