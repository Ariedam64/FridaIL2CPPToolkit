import { describe, it, expect } from "vitest";
import { extractWorldDims } from "../../../../plugins/dofus/lib/world-dims";

describe("extractWorldDims", () => {
    it("returns the dims object when all 6 fields are present (canonical naming)", () => {
        const w = {
            id: 1,
            origineX: -85, origineY: -90,
            mapWidth: 86, mapHeight: 43,
            totalWidth: 13072, totalHeight: 5418,
        };
        expect(extractWorldDims(w)).toEqual({
            origineX: -85, origineY: -90,
            mapWidth: 86, mapHeight: 43,
            totalWidth: 13072, totalHeight: 5418,
        });
    });

    it("falls back to m_-prefixed naming when canonical fields missing", () => {
        const w = {
            id: 1,
            m_origineX: -85, m_origineY: -90,
            m_mapWidth: 86, m_mapHeight: 43,
            m_totalWidth: 13072, m_totalHeight: 5418,
        };
        expect(extractWorldDims(w)).toEqual({
            origineX: -85, origineY: -90,
            mapWidth: 86, mapHeight: 43,
            totalWidth: 13072, totalHeight: 5418,
        });
    });

    it("returns undefined when any field is missing", () => {
        const w = {
            id: 1,
            origineX: -85, origineY: -90,
            mapWidth: 86, mapHeight: 43,
            // totalWidth missing
            totalHeight: 5418,
        };
        expect(extractWorldDims(w)).toBeUndefined();
    });

    it("returns undefined when any field is non-finite", () => {
        const w = {
            id: 1,
            origineX: -85, origineY: -90,
            mapWidth: 86, mapHeight: NaN,
            totalWidth: 13072, totalHeight: 5418,
        };
        expect(extractWorldDims(w)).toBeUndefined();
    });
});
