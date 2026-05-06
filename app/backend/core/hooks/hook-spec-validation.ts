import type { HookSpec, HookTemplate } from "./types";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

const TEMPLATES: ReadonlySet<HookTemplate> = new Set([
    "log", "noop", "force-return", "log-stack",
]);

export function validateHookSpec(input: unknown): ValidationResult {
    if (!input || typeof input !== "object") return { ok: false, reason: "spec is not an object" };
    const spec = input as Partial<HookSpec>;
    if (typeof spec.template !== "string" || !TEMPLATES.has(spec.template as HookTemplate)) {
        return { ok: false, reason: `unknown template: ${String(spec.template)}` };
    }
    if (typeof spec.className !== "string" || spec.className.length === 0) {
        return { ok: false, reason: "className must be a non-empty string" };
    }
    if (typeof spec.methodName !== "string" || spec.methodName.length === 0) {
        return { ok: false, reason: "methodName must be a non-empty string" };
    }
    if (spec.template === "force-return") {
        if (!("forceReturnValue" in spec)) {
            return { ok: false, reason: "force-return requires forceReturnValue" };
        }
    }
    if (spec.stackCaptureCount !== undefined) {
        if (typeof spec.stackCaptureCount !== "number" || spec.stackCaptureCount < 0) {
            return { ok: false, reason: "stackCaptureCount must be >= 0" };
        }
    }
    return { ok: true };
}
