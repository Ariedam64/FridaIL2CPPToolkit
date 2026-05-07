// RPC methods for Sentry breadcrumb / capture interception.
//
// Why : the Dofus client embeds Sentry SDK (Sentry.dll, Sentry.Unity.dll). OPS
// Obfuscator does NOT touch third-party assemblies, and never encrypts strings,
// so calls like `SentrySdk.AddBreadcrumb("MapTransitionStart", "navigation")`
// retain their human-readable arguments at runtime. Hooking the 4 static entry
// points lets us harvest these labels passively during gameplay — they map
// directly to Ankama feature names (navigation/fight/inventory/...) that we
// can then triangulate against obfuscated callers via `Il2Cpp.backtrace()`.
//
// Cost of these hooks is low: SentrySdk is called on errors and lifecycle
// events, never per-frame. Safe to leave armed for the whole session.

import "frida-il2cpp-bridge";
import { findClass } from "../lib";

function inVm<T>(fn: () => T | Promise<T>): Promise<T> {
    return Il2Cpp.perform(fn) as Promise<T>;
}

type SentryMethod =
    | "AddBreadcrumb"
    | "CaptureMessage"
    | "CaptureException"
    | "CaptureEvent";

export interface SentryEntry {
    ts: number;
    method: SentryMethod;
    overload: string;        // e.g. "string,string,string,IDictionary,BreadcrumbLevel"
    message?: string;
    category?: string;
    type?: string;
    level?: string;
    exceptionType?: string;
    exceptionMessage?: string;
    exceptionStack?: string;
    eventLogger?: string;
    eventMessage?: string;
    extras?: Record<string, string>;
    backtrace?: string[];    // top N frames (class.method) — for triangulating callers
}

interface InstalledHook {
    klass: string;
    method: string;
    overload: string;
}

const collected: SentryEntry[] = [];
const installedHooks: InstalledHook[] = [];
const COLLECTION_MAX = 5000;

function safeStr(v: any): string {
    if (v === null || v === undefined) return "";
    try {
        if (typeof v === "string") return v;
        // frida-il2cpp-bridge surfaces Il2Cpp strings with a `.content` getter.
        if (typeof (v as any).content === "string") return (v as any).content;
        return String(v).replace(/^"|"$/g, "");
    } catch {
        return "<?>";
    }
}

// Try to capture the IL2CPP-side caller — this is what makes Sentry hooks
// valuable beyond just the literal strings: each AddBreadcrumb call site
// belongs to a specific obfuscated class, which we can then label.
function captureBacktrace(maxFrames = 6): string[] {
    const out: string[] = [];
    try {
        // frida-il2cpp-bridge does not surface backtraces directly; fall back
        // to Frida's native Thread.backtrace() (uses current thread context).
        const frames = Thread.backtrace(undefined, Backtracer.ACCURATE).slice(0, maxFrames);
        for (const f of frames) {
            const sym = DebugSymbol.fromAddress(f);
            out.push(sym.toString());
        }
    } catch { /* backtrace can fail in strange contexts; non-fatal */ }
    return out;
}

function pushEntry(e: SentryEntry): void {
    if (collected.length >= COLLECTION_MAX) collected.shift();
    collected.push(e);
}

// Hook a specific overload. Returns true if the hook was installed.
function hookOverload(
    klassName: string,
    methodName: SentryMethod,
    paramTypes: string[],
    extract: (args: any[]) => Partial<SentryEntry>,
    captureStack = false,
): boolean {
    const klass = findClass(klassName);
    if (!klass) {
        console.log(`[sentry] class '${klassName}' not found — skip ${methodName}`);
        return false;
    }
    let method: Il2Cpp.Method<any>;
    try {
        method = klass.method(methodName).overload(...paramTypes);
    } catch (e) {
        console.log(`[sentry] overload ${methodName}(${paramTypes.join(",")}) not on ${klassName}: ${String(e).slice(0, 120)}`);
        return false;
    }
    const overloadKey = paramTypes.join(",");
    method.implementation = function (this: any, ...args: any[]): any {
        try {
            const partial = extract(args);
            const entry: SentryEntry = {
                ts: Date.now(),
                method: methodName,
                overload: overloadKey,
                ...partial,
            };
            if (captureStack) entry.backtrace = captureBacktrace(6);
            pushEntry(entry);
        } catch { /* never let our instrumentation crash the call */ }
        const self = this as Il2Cpp.Object;
        if (method.isStatic) return klass.method(methodName).overload(...paramTypes).invoke(...args);
        return self.method(methodName).overload(...paramTypes).invoke(...args);
    };
    installedHooks.push({ klass: klassName, method: methodName, overload: overloadKey });
    console.log(`[sentry] hooked ${klassName}.${methodName}(${overloadKey})`);
    return true;
}

function extractAddBreadcrumb1(args: any[]): Partial<SentryEntry> {
    return {
        message: safeStr(args[0]),
        category: safeStr(args[1]),
        type: safeStr(args[2]),
        level: safeStr(args[4]),
    };
}

function extractAddBreadcrumb2(args: any[]): Partial<SentryEntry> {
    return {
        message: safeStr(args[0]),
        category: safeStr(args[1]),
        type: safeStr(args[2]),
        level: safeStr(args[4]),
        extras: { hasHint: args[1] != null ? "1" : "0" },
    };
}

function extractCaptureMessage(args: any[]): Partial<SentryEntry> {
    return {
        message: safeStr(args[0]),
        level: safeStr(args[1]),
    };
}

function extractException(args: any[]): Partial<SentryEntry> {
    const ex = args[0];
    let type = "?", message = "?", stack = "";
    if (ex && (ex as any).class) {
        try { type = (ex as any).class.name; } catch {}
        try { message = safeStr(ex.method("get_Message").invoke()); } catch {}
        try { stack = safeStr(ex.method("get_StackTrace").invoke()); } catch {}
    }
    return { exceptionType: type, exceptionMessage: message, exceptionStack: stack };
}

function extractEvent(args: any[]): Partial<SentryEntry> {
    const evt = args[0];
    if (!evt || !(evt as any).class) return {};
    let logger = "", msg = "";
    try { logger = safeStr(evt.tryMethod?.("get_Logger")?.invoke?.()); } catch {}
    try {
        const m = evt.tryMethod?.("get_Message")?.invoke?.();
        if (m && (m as any).class) {
            // SentryMessage has Message, Formatted, Template fields.
            try { msg = safeStr(m.tryMethod?.("get_Formatted")?.invoke?.()); } catch {}
            if (!msg) try { msg = safeStr(m.tryMethod?.("get_Message")?.invoke?.()); } catch {}
        }
    } catch {}
    return { eventLogger: logger, eventMessage: msg };
}

/**
 * Install all known Sentry SDK hooks. Idempotent-ish: re-running will skip
 * already-hooked overloads (frida-il2cpp-bridge no-ops on identical impl).
 *
 * @param captureStack  attach Frida-level Thread.backtrace() to each entry
 *                      (more expensive but lets us identify the obfuscated
 *                      caller class — this is the whole point).
 */
export function installSentryHooks(captureStack: boolean = true): Promise<{ installed: number; total: number; details: InstalledHook[] }> {
    return inVm(() => {
        const before = installedHooks.length;

        // SentrySdk.AddBreadcrumb(string, string, string, IDictionary<string,string>, BreadcrumbLevel)
        hookOverload("SentrySdk", "AddBreadcrumb",
            ["System.String", "System.String", "System.String", "System.Collections.Generic.IDictionary`2", "Sentry.BreadcrumbLevel"],
            extractAddBreadcrumb1, captureStack);

        // SentrySdk.AddBreadcrumb(ISystemClock, string, string, string, IDictionary, BreadcrumbLevel)
        hookOverload("SentrySdk", "AddBreadcrumb",
            ["Sentry.Infrastructure.ISystemClock", "System.String", "System.String", "System.String", "System.Collections.Generic.IDictionary`2", "Sentry.BreadcrumbLevel"],
            (args) => ({
                message: safeStr(args[1]),
                category: safeStr(args[2]),
                type: safeStr(args[3]),
                level: safeStr(args[5]),
            }), captureStack);

        // SentrySdk.AddBreadcrumb(Breadcrumb, SentryHint)
        hookOverload("SentrySdk", "AddBreadcrumb",
            ["Sentry.Breadcrumb", "Sentry.SentryHint"],
            (args) => {
                const bc = args[0];
                let message = "", category = "", type = "", level = "";
                if (bc && (bc as any).class) {
                    try { message = safeStr(bc.tryMethod?.("get_Message")?.invoke?.()); } catch {}
                    try { category = safeStr(bc.tryMethod?.("get_Category")?.invoke?.()); } catch {}
                    try { type = safeStr(bc.tryMethod?.("get_Type")?.invoke?.()); } catch {}
                    try { level = safeStr(bc.tryMethod?.("get_Level")?.invoke?.()); } catch {}
                }
                return { message, category, type, level };
            }, captureStack);

        // SentrySdk.CaptureMessage(string, SentryLevel)
        hookOverload("SentrySdk", "CaptureMessage",
            ["System.String", "Sentry.SentryLevel"],
            extractCaptureMessage, captureStack);

        // SentrySdk.CaptureMessage(string, Action<Scope>, SentryLevel)
        hookOverload("SentrySdk", "CaptureMessage",
            ["System.String", "System.Action`1", "Sentry.SentryLevel"],
            (args) => ({ message: safeStr(args[0]), level: safeStr(args[2]) }), captureStack);

        // SentrySdk.CaptureException(Exception)
        hookOverload("SentrySdk", "CaptureException",
            ["System.Exception"],
            extractException, captureStack);

        // SentrySdk.CaptureException(Exception, Action<Scope>)
        hookOverload("SentrySdk", "CaptureException",
            ["System.Exception", "System.Action`1"],
            extractException, captureStack);

        // SentrySdk.CaptureEvent(SentryEvent, Scope, SentryHint) — full event payload
        hookOverload("SentrySdk", "CaptureEvent",
            ["Sentry.SentryEvent", "Sentry.Scope", "Sentry.SentryHint"],
            extractEvent, captureStack);

        return {
            installed: installedHooks.length - before,
            total: installedHooks.length,
            details: installedHooks.slice(before),
        };
    });
}

/** Latest N entries (default 1000), most recent last. */
export function getSentryBreadcrumbs(limit: number = 1000): Promise<SentryEntry[]> {
    return inVm(() => collected.slice(-limit));
}

/** Empty the collection. Returns the count cleared. */
export function clearSentryBreadcrumbs(): Promise<number> {
    return inVm(() => { const n = collected.length; collected.length = 0; return n; });
}

/** Lightweight stats — total count, breakdown per method, list of hooked overloads. */
export function getSentryStats(): Promise<{ total: number; byMethod: Record<string, number>; byCategory: Record<string, number>; hooks: InstalledHook[] }> {
    return inVm(() => {
        const byMethod: Record<string, number> = {};
        const byCategory: Record<string, number> = {};
        for (const e of collected) {
            byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
            const c = e.category ?? "(none)";
            byCategory[c] = (byCategory[c] ?? 0) + 1;
        }
        return { total: collected.length, byMethod, byCategory, hooks: installedHooks.slice() };
    });
}
