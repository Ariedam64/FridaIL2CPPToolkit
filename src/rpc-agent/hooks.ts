// RPC methods for managing Frida hooks installed against IL2CPP methods.
//
// Two flavors of API live here:
//
//   - Legacy one-shot RPCs (`hook`, `replaceNoop`, `forceReturn`,
//     `patchStatic`, `callStatic`, `callStaticOverload`) used by the
//     standalone tools and ad-hoc reverse-engineering. Kept as-is.
//
//   - Managed lifecycle RPCs (`installHook` / `revertHook` /
//     `listInstalledHooks` / `clearAllHooks`) consumed by the
//     Toolkit's Hooks plugin. Each managed hook has an opaque
//     `hookId` so the plugin can revert and re-install on edit.
//
// Managed hooks emit `HookEvent` payloads via Frida `send()` — the
// plugin subscribes via `coreApi.onAgentMessage`. Direct-mode only
// (HTTP RPC has no event channel back to the host).

import "frida-il2cpp-bridge";
import {
    findClass,
    findClassExact,
    hookLog,
    hookNoop,
    setStatic,
    forceReturn as libForceReturn,
    callStatic as libCallStatic,
    stringifyValue,
    getStackFrames,
} from "../lib";
import { coerce } from "./registry";
import { notFoundClass, notFoundMethod } from "./errors";
import type { HookAutoRevertEvent, HookEvent, HookSpec, InstalledHook } from "./hook-types";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Legacy one-shot RPCs (preserved)
// ---------------------------------------------------------------------------

export function hook(className: string, methodName: string): Promise<void> {
    return inVm(() => hookLog(className, methodName));
}

export function replaceNoop(className: string, methodName: string): Promise<void> {
    return inVm(() => hookNoop(className, methodName));
}

export function patchStatic(className: string, field: string, value: any): Promise<void> {
    return inVm(() => setStatic(className, field, value));
}

export function forceReturn(className: string, method: string, value: any): Promise<void> {
    return inVm(() => libForceReturn(className, method, value));
}

export function callStatic(className: string, method: string, args: any[] = []): Promise<string> {
    return inVm(() => {
        const res = libCallStatic(className, method, ...args);
        return String(res);
    });
}

export function callStaticOverload(className: string, methodName: string, paramTypes: string[], args: any[] = []): Promise<string> {
    return inVm(() => {
        const klass = findClass(className);
        if (!klass) throw notFoundClass(className);
        const method = klass.method(methodName).overload(...paramTypes);
        const coerced = args.map((v, i) => coerce(v, paramTypes[i]));
        const res = method.invoke(...coerced);
        return stringifyValue(res);
    });
}

// ---------------------------------------------------------------------------
// Managed hook lifecycle (used by the Hooks plugin)
// ---------------------------------------------------------------------------

interface ManagedEntry {
    spec: HookSpec;
    method: Il2Cpp.Method;
    installedAt: number;
    hitCount: number;
    // Flood detection
    throwCount: number;       // total throws since install
    throwWindowStart: number; // ts when the current 1s window started
    throwsInWindow: number;
}

const _managed = new Map<string, ManagedEntry>();
let _hookIdCounter = 0;

function emit(payload: Omit<HookEvent, "type" | "ts">): void {
    const evt: HookEvent = { type: "hook-event", ts: Date.now(), ...payload };
    try { send(evt); } catch { /* host gone, drop */ }
}

function safeSelf(self: any): string | null {
    if (!self) return null;
    try {
        const cls = self.class?.name;
        const handle = self.handle;
        if (cls && handle) return `${cls}@${handle}`;
    } catch {}
    return null;
}

function safeArgs(args: any[]): string[] {
    return args.map((a) => {
        try { return stringifyValue(a); }
        catch (e) { return `<err: ${String(e).slice(0, 60)}>`; }
    });
}

function safeRetval(r: any): string | null {
    try { return stringifyValue(r); }
    catch (e) { return `<err: ${String(e).slice(0, 60)}>`; }
}

const FLOOD_WINDOW_MS = 1000;
const FLOOD_MAX_THROWS = 50;

function emitAutoRevert(hookId: string, reason: string, detail?: string): void {
    const evt: HookAutoRevertEvent = { type: "hook-auto-revert", hookId, ts: Date.now(), reason, detail };
    try { send(evt); } catch { /* host gone */ }
}

function autoRevert(hookId: string, reason: string, detail?: string): void {
    const entry = _managed.get(hookId);
    if (!entry) return;
    try { entry.method.revert(); } catch {}
    _managed.delete(hookId);
    emitAutoRevert(hookId, reason, detail);
    console.log(`[hooks] auto-reverted ${hookId} (${reason}): ${detail ?? ""}`);
}

function isLookupError(err: unknown): boolean {
    const s = String(err);
    return s.includes("couldn't find") || s.includes("Il2CppError");
}

function installLogTemplate(hookId: string, entry: ManagedEntry, captureStack: boolean): void {
    const { method } = entry;
    const isStatic = method.isStatic;
    const klass = method.class;
    const methodName = entry.spec.methodName;

    method.implementation = function (this: any, ...args: any[]): any {
        const self = isStatic ? null : (this as Il2Cpp.Object);
        const argsStr = safeArgs(args);
        const selfStr = safeSelf(self);

        let stackFrames: string[] | undefined;
        // Capture BEFORE incrementing so hitCount=0 on the first hit (limit=5 → captures hits 0..4).
        if (captureStack) {
            const limit = entry.spec.stackCaptureCount ?? 5;
            if (entry.hitCount < limit && this.context) {
                try { stackFrames = getStackFrames(this.context, 20); } catch {}
            }
        }
        entry.hitCount++;

        let result: any;
        try {
            result = isStatic
                ? klass.method(methodName).invoke(...args)
                : (this as Il2Cpp.Object).method(methodName).invoke(...args);
        } catch (err) {
            entry.throwCount++;
            const now = Date.now();
            if (now - entry.throwWindowStart > FLOOD_WINDOW_MS) {
                entry.throwWindowStart = now;
                entry.throwsInWindow = 1;
            } else {
                entry.throwsInWindow++;
            }
            emit({ hookId, self: selfStr, args: argsStr, retval: null, error: String(err), stackFrames });

            // Two auto-revert triggers: clear lookup errors (likely wrong class
            // identity), or sustained throw flood (>50 throws in 1s).
            if (isLookupError(err)) {
                autoRevert(hookId, "lookup-error", String(err).slice(0, 200));
                // Don't re-throw — we don't want to propagate to the original caller
                // because the original target wasn't us anyway. Return undefined.
                return undefined;
            }
            if (entry.throwsInWindow >= FLOOD_MAX_THROWS) {
                autoRevert(hookId, "throw-flood", `${entry.throwsInWindow} throws in <1s`);
                return undefined;
            }

            throw err;
        }
        emit({ hookId, self: selfStr, args: argsStr, retval: safeRetval(result), stackFrames });
        return result;
    };
}

function installNoopTemplate(hookId: string, entry: ManagedEntry): void {
    const { method } = entry;
    method.implementation = function (this: any, ..._args: any[]): any {
        entry.hitCount++;
        emit({ hookId, self: safeSelf(this), args: [], retval: null });
        return undefined;
    };
}

function installForceReturnTemplate(hookId: string, entry: ManagedEntry): void {
    const { method, spec } = entry;
    const retTypeName = method.returnType.name;

    method.implementation = function (this: any, ..._args: any[]): any {
        entry.hitCount++;
        let coercedReturn: any;
        try {
            coercedReturn = coerce(spec.forceReturnValue, retTypeName);
        } catch {
            coercedReturn = spec.forceReturnValue;
        }
        emit({ hookId, self: safeSelf(this), args: [], retval: safeRetval(coercedReturn) });
        return coercedReturn;
    };
}

export function installHook(spec: HookSpec): Promise<{ hookId: string }> {
    return inVm(() => {
        const klass = findClassExact(spec.className);
        if (!klass) throw notFoundClass(spec.className);
        const method = klass.tryMethod(spec.methodName);
        if (!method) throw notFoundMethod(spec.className, spec.methodName);

        const hookId = `h${++_hookIdCounter}`;
        const entry: ManagedEntry = {
            spec, method, installedAt: Date.now(), hitCount: 0,
            throwCount: 0, throwWindowStart: 0, throwsInWindow: 0,
        };

        switch (spec.template) {
            case "log":        installLogTemplate(hookId, entry, false); break;
            case "log-stack":  installLogTemplate(hookId, entry, true); break;
            case "noop":       installNoopTemplate(hookId, entry); break;
            case "force-return":
                if (!("forceReturnValue" in spec)) {
                    throw new Error("force-return requires spec.forceReturnValue");
                }
                installForceReturnTemplate(hookId, entry);
                break;
            default:
                throw new Error(`unknown template: ${(spec as { template: string }).template}`);
        }

        _managed.set(hookId, entry);
        return { hookId };
    });
}

export function revertHook(hookId: string): Promise<{ reverted: boolean }> {
    return inVm(() => {
        const entry = _managed.get(hookId);
        if (!entry) return { reverted: false };
        try { entry.method.revert(); } catch {}
        _managed.delete(hookId);
        return { reverted: true };
    });
}

export function listInstalledHooks(): InstalledHook[] {
    const out: InstalledHook[] = [];
    _managed.forEach((entry, hookId) => {
        out.push({ hookId, spec: entry.spec, installedAt: entry.installedAt });
    });
    return out;
}

export function clearAllHooks(): Promise<{ count: number }> {
    return inVm(() => {
        let count = 0;
        _managed.forEach((entry) => {
            try { entry.method.revert(); count++; } catch {}
        });
        _managed.clear();
        return { count };
    });
}
