import { describe, it, expect, beforeEach } from "vitest";
import { HistoryStore } from "../../../../backend/core/instances/history-store";
import type { HistoryEntry } from "../../../../backend/core/instances/types";

const makeEntry = (id: string): HistoryEntry => ({
    id,
    timestamp: new Date().toISOString(),
    action: "write",
    target: { instanceKey: "player", member: "health" },
    before: "100",
    after: "9999",
    success: true,
});

describe("HistoryStore", () => {
    let h: HistoryStore;
    beforeEach(() => { h = new HistoryStore(); });

    it("append + list returns entries in reverse chronological order", () => {
        h.append(makeEntry("a"));
        h.append(makeEntry("b"));
        h.append(makeEntry("c"));
        expect(h.list().map((e) => e.id)).toEqual(["c", "b", "a"]);
    });

    it("evicts oldest beyond MAX (50)", () => {
        for (let i = 0; i < 51; i++) h.append(makeEntry(`e${i}`));
        const list = h.list();
        expect(list).toHaveLength(50);
        expect(list[0].id).toBe("e50");
        expect(list[49].id).toBe("e1");
    });

    it("clear empties the store", () => {
        h.append(makeEntry("a"));
        h.clear();
        expect(h.list()).toHaveLength(0);
    });

    it("onChange emits on append + clear", () => {
        let count = 0;
        h.onChange(() => { count++; });
        h.append(makeEntry("a"));
        h.append(makeEntry("b"));
        h.clear();
        expect(count).toBe(3);
    });
});
