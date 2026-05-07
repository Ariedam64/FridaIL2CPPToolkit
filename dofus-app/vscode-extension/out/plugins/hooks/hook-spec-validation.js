"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateHookSpec = validateHookSpec;
const TEMPLATES = new Set([
    "log", "noop", "force-return", "log-stack",
]);
function validateHookSpec(input) {
    if (!input || typeof input !== "object")
        return { ok: false, reason: "spec is not an object" };
    const spec = input;
    if (typeof spec.template !== "string" || !TEMPLATES.has(spec.template)) {
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
//# sourceMappingURL=hook-spec-validation.js.map