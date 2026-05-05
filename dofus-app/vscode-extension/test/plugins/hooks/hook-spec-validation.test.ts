import { describe, it, expect } from "vitest";

import { validateHookSpec } from "../../../src/plugins/hooks/hook-spec-validation";

const ok = (template: string, extra: Record<string, unknown> = {}) => ({
    template, className: "X", methodName: "y", ...extra,
});

describe("validateHookSpec", () => {
    it("accepts a minimal log spec", () => {
        const r = validateHookSpec(ok("log"));
        expect(r.ok).toBe(true);
    });

    it("accepts noop", () => {
        expect(validateHookSpec(ok("noop")).ok).toBe(true);
    });

    it("accepts log-stack with stackCaptureCount", () => {
        expect(validateHookSpec(ok("log-stack", { stackCaptureCount: 5 })).ok).toBe(true);
    });

    it("accepts log-stack without stackCaptureCount (defaulted agent-side)", () => {
        expect(validateHookSpec(ok("log-stack")).ok).toBe(true);
    });

    it("rejects force-return without forceReturnValue", () => {
        const r = validateHookSpec(ok("force-return"));
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toMatch(/forceReturnValue/);
    });

    it("accepts force-return with forceReturnValue (any type, even null)", () => {
        expect(validateHookSpec(ok("force-return", { forceReturnValue: 0 })).ok).toBe(true);
        expect(validateHookSpec(ok("force-return", { forceReturnValue: null })).ok).toBe(true);
        expect(validateHookSpec(ok("force-return", { forceReturnValue: "" })).ok).toBe(true);
    });

    it("rejects unknown template", () => {
        const r = validateHookSpec(ok("does-not-exist"));
        expect(r.ok).toBe(false);
    });

    it("rejects empty className or methodName", () => {
        expect(validateHookSpec({ template: "log", className: "", methodName: "y" }).ok).toBe(false);
        expect(validateHookSpec({ template: "log", className: "X", methodName: "" }).ok).toBe(false);
    });

    it("rejects negative stackCaptureCount", () => {
        const r = validateHookSpec(ok("log-stack", { stackCaptureCount: -1 }));
        expect(r.ok).toBe(false);
    });
});
