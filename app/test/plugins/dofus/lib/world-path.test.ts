import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { computeWorldPath, type ExtractedWorldGraph } from "../../../../plugins/dofus/lib/movement/world-path";

// Tiny in-memory graph: maps 1 → 2 → 3, single walkable transition each.
const MINI_GRAPH: ExtractedWorldGraph = {
    vertices: {
        "v1": { mapId: "1", zoneId: 1, uid: "v1" },
        "v2": { mapId: "2", zoneId: 1, uid: "v2" },
        "v3": { mapId: "3", zoneId: 1, uid: "v3" },
    },
    outgoing: {
        "v1": [{ fromUid: "v1", toUid: "v2", transitions: [{ cellId: 100, direction: 1, skillId: 0, transitionMapId: "2", type: 0, criterion: null, id: "t1" }] }],
        "v2": [{ fromUid: "v2", toUid: "v3", transitions: [{ cellId: 200, direction: 2, skillId: 0, transitionMapId: "3", type: 0, criterion: null, id: "t2" }] }],
        "v3": [],
    },
    verticesByMap: {
        "1": { "1": "v1" },
        "2": { "1": "v2" },
        "3": { "1": "v3" },
    },
};

describe("computeWorldPath", () => {
    it("returns ok with empty edges when src === dest", () => {
        const r = computeWorldPath(1, 1, MINI_GRAPH);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.edges).toEqual([]);
    });

    it("returns ok with edges for a valid 1→2→3 path", () => {
        const r = computeWorldPath(1, 3, MINI_GRAPH);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.edges.length).toBe(2);
            expect(r.edges[0].from.mapId).toBe("1");
            expect(r.edges[0].to.mapId).toBe("2");
            expect(r.edges[1].to.mapId).toBe("3");
        }
    });

    it("rejects when destMapId is not in graph", () => {
        const r = computeWorldPath(1, 999, MINI_GRAPH);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("destMapId 999 not in graph");
    });

    it("rejects when srcMapId is not in graph", () => {
        const r = computeWorldPath(999, 1, MINI_GRAPH);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("srcMapId 999 not in graph");
    });

    it("rejects when no path exists", () => {
        // Graph where 2 has no outgoing — 1 can reach 2 but not 3.
        const stuck: ExtractedWorldGraph = {
            ...MINI_GRAPH,
            outgoing: { ...MINI_GRAPH.outgoing, "v2": [] },
        };
        const r = computeWorldPath(1, 3, stuck);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toContain("no path to 3");
    });
});
