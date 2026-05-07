import { describe, it, expect } from "vitest";
import { decodeCellFlags, cellColor } from "../../../../plugins/dofus/lib/cell-flags";

describe("decodeCellFlags", () => {
    it("flags=0 → all false", () => {
        expect(decodeCellFlags(0)).toEqual({
            mov: false, los: false, nonRP: false,
            farm: false, visible: false, havenbag: false,
        });
    });

    it("flags=0b1100001 (mov + los + havenbag) → those 3 true", () => {
        // bits: 0(mov), 1(los), 6(havenbag) → 1 + 2 + 64 = 67 = 0b1000011
        const f = decodeCellFlags(0b1000011);
        expect(f.mov).toBe(true);
        expect(f.los).toBe(true);
        expect(f.havenbag).toBe(true);
        expect(f.visible).toBe(false);
        expect(f.farm).toBe(false);
        expect(f.nonRP).toBe(false);
    });
});

describe("cellColor", () => {
    it("invisible (no bit 5) → null", () => {
        expect(cellColor(0b0000001, 0)).toBeNull();  // mov but not visible
    });

    it("visible + walkable (mov) → green '#3a7b3a'", () => {
        expect(cellColor(0b0100001, 0)).toBe("#3a7b3a");  // visible + mov
    });

    it("visible + non-mov + los → wall '#4a4030'", () => {
        expect(cellColor(0b0100010, 0)).toBe("#4a4030");  // visible + los, no mov
    });

    it("visible + non-mov + non-los → dark wall '#2a2520'", () => {
        expect(cellColor(0b0100000, 0)).toBe("#2a2520");  // visible only
    });

    it("visible + mov + farm → yellow '#d9b02c'", () => {
        expect(cellColor(0b0110001, 0)).toBe("#d9b02c");  // visible + mov + farm
    });

    it("visible + mov + havenbag → cyan '#3cd'", () => {
        expect(cellColor(0b1100001, 0)).toBe("#3cd");
    });

    it("visible + mov + mcd > 0 → orange '#ff9d00'", () => {
        expect(cellColor(0b0100001, 1)).toBe("#ff9d00");
    });
});
