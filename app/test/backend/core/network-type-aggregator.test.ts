import { describe, it, expect } from "vitest";
import { aggregate } from "../../../backend/core/network/type-aggregator";
import type { NetworkFrame } from "../../../backend/core/network/types";

function mkFrame(id: string, direction: "in" | "out", className: string, fields: string[] = [], t = 1): NetworkFrame {
    return {
        id, timestamp: t, direction,
        typeKey: { ns: null, className },
        fields: fields.map((f) => ({ name: f, kind: "int" as const, preview: "0" })),
    };
}

describe("aggregate", () => {
    it("groups by typeKey and counts", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A"),
            mkFrame("f-2", "in", "A"),
            mkFrame("f-3", "out", "B"),
        ]);
        expect(out).toHaveLength(2);
        const a = out.find((m) => m.key.className === "A")!;
        expect(a.count).toBe(2);
        expect(a.countByDirection).toEqual({ in: 2, out: 0 });
    });

    it("computes lastSeenAt as the max timestamp", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A", [], 100),
            mkFrame("f-2", "in", "A", [], 500),
            mkFrame("f-3", "in", "A", [], 300),
        ]);
        expect(out[0].lastSeenAt).toBe(500);
    });

    it("collects observedFields as union, in first-seen order", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A", ["a", "b"]),
            mkFrame("f-2", "in", "A", ["b", "c"]),
            mkFrame("f-3", "in", "A", ["a", "d"]),
        ]);
        expect(out[0].observedFields).toEqual(["a", "b", "c", "d"]);
    });

    it("splits direction counts", () => {
        const out = aggregate([
            mkFrame("f-1", "in", "A"),
            mkFrame("f-2", "out", "A"),
            mkFrame("f-3", "out", "A"),
        ]);
        expect(out[0].countByDirection).toEqual({ in: 1, out: 2 });
    });

    it("returns empty array for empty input", () => {
        expect(aggregate([])).toEqual([]);
    });

    it("treats different ns as different types", () => {
        const out = aggregate([
            { id: "f-1", timestamp: 1, direction: "in", typeKey: { ns: "X", className: "A" }, fields: [] },
            { id: "f-2", timestamp: 1, direction: "in", typeKey: { ns: "Y", className: "A" }, fields: [] },
        ]);
        expect(out).toHaveLength(2);
    });
});
