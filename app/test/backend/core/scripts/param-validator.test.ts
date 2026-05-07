import { describe, it, expect } from "vitest";
import { validateParamValues } from "../../../../backend/core/scripts/param-validator";
import type { ParamSchema } from "../../../../backend/core/scripts/types";

describe("validateParamValues", () => {
    const numSchema: ParamSchema = { mapId: { type: "number", required: true, min: 1, max: 1000 } };

    it("returns parsed values when valid", () => {
        const r = validateParamValues({ x: { type: "number", required: true } }, { x: 42 });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.values).toEqual({ x: 42 });
    });

    it("rejects missing required param", () => {
        const r = validateParamValues(numSchema, {});
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/missing required param: mapId/);
    });

    it("rejects wrong type", () => {
        const r = validateParamValues(numSchema, { mapId: "abc" });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*number/);
    });

    it("rejects number out of range (min)", () => {
        const r = validateParamValues(numSchema, { mapId: 0 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*min 1/);
    });

    it("rejects number out of range (max)", () => {
        const r = validateParamValues(numSchema, { mapId: 9999 });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mapId.*max 1000/);
    });

    it("rejects enum value not in list", () => {
        const r = validateParamValues(
            { mode: { type: "enum", values: ["fast", "slow"] } },
            { mode: "medium" },
        );
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/mode.*not in/);
    });

    it("rejects extra param not in schema", () => {
        const r = validateParamValues(numSchema, { mapId: 1, extra: true });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/unknown param: extra/);
    });

    it("applies defaults when value omitted", () => {
        const r = validateParamValues(
            { force: { type: "boolean", default: false } },
            {},
        );
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.values).toEqual({ force: false });
    });

    it("accepts boolean true/false", () => {
        const r = validateParamValues({ b: { type: "boolean" } }, { b: true });
        expect(r.ok).toBe(true);
    });
});
