// Cache for IL2CPP singletons.
//
// `Il2Cpp.gc.choose(klass)` is the only way to discover live instances —
// the runtime has no manager registry. Each call walks the entire managed
// heap and costs ~100-500ms on Dofus 3. Without caching, a single RPC
// that touches three managers can stall the game for >1s.
//
// This module stores `name → instance` and probes liveness on each read
// (a dead handle throws when you read `.class.name`). On miss it pays the
// gc.choose cost ONCE and caches the result. Designed for true singletons
// (managers, services, controllers) — not for things you'd legitimately
// want to enumerate fresh each time.
//
// Usage:
//   import { getSingleton, prewarmSingletons, invalidateSingleton } from "./singleton-cache";
//   const ecu = getSingleton("ecu");           // first call: gc.choose
//   const ecuAgain = getSingleton("ecu");      // O(1) cached
//   prewarmSingletons(["dun", "dvi", "ecu"]);  // opt-in eager populate

import "frida-il2cpp-bridge";
import { findClass } from "../lib/search";

let _singletons: Map<string, Il2Cpp.Object> | null = null;

function isAlive(obj: Il2Cpp.Object): boolean {
    try { return !!(obj.class && obj.class.name); }
    catch { return false; }
}

function pickLatest(arr: Il2Cpp.Object[]): Il2Cpp.Object | null {
    return arr.length ? arr[arr.length - 1] : null;
}

/**
 * Get a cached singleton instance. On a miss (or stale handle) re-scans
 * the heap once via `Il2Cpp.gc.choose`. Returns `null` if no live instance
 * exists OR the class isn't found.
 *
 * Conventionally returns the LATEST element of `gc.choose` (the freshest
 * instance, matching what `sender.ts` already did before this module).
 */
export function getSingleton(target: string | Il2Cpp.Class): Il2Cpp.Object | null {
    const klass = typeof target === "string" ? findClass(target) : target;
    if (!klass) return null;
    if (!_singletons) _singletons = new Map();
    const key = klass.name;

    const cached = _singletons.get(key);
    if (cached && isAlive(cached)) return cached;

    const insts = Il2Cpp.gc.choose(klass);
    const fresh = pickLatest(insts);
    if (fresh) {
        _singletons.set(key, fresh);
    } else {
        _singletons.delete(key);
    }
    return fresh;
}

/**
 * Force a re-scan on the next `getSingleton(name)`. Useful if the caller
 * knows the cached handle is stale (e.g. just hooked a constructor).
 */
export function invalidateSingleton(name: string): void {
    _singletons?.delete(name);
}

/** Drop every cached singleton — call on detach or before re-init. */
export function clearSingletonCache(): void {
    _singletons?.clear();
}

/**
 * Eagerly populate the cache with a list of class names. Useful at boot
 * to amortize the gc.choose cost off the user's first interactive RPC.
 * Returns the names that resolved to a live instance.
 */
export function prewarmSingletons(names: string[]): string[] {
    const ok: string[] = [];
    for (const n of names) {
        if (getSingleton(n)) ok.push(n);
    }
    return ok;
}

/** Diagnostic: which names are currently cached. */
export function listCachedSingletons(): string[] {
    return _singletons ? Array.from(_singletons.keys()) : [];
}
