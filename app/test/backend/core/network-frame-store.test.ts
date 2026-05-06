import { describe, it, expect, beforeEach } from "vitest";
import { FrameStore } from "../../../backend/core/network/frame-store";
import type { NetworkFrame, TypeKey } from "../../../backend/core/network/types";

const KEY_A: TypeKey = { ns: "Game.Net", className: "MapMovement" };
const KEY_B: TypeKey = { ns: null, className: "MoveRequest" };

function mkFrame(direction: "in" | "out", key: TypeKey, t = 1000): Omit<NetworkFrame, "id"> {
    return { timestamp: t, direction, typeKey: key, fields: [] };
}

let store: FrameStore;
beforeEach(() => { store = new FrameStore(5); });

describe("FrameStore", () => {
    it("assigns monotonic ids in push order", () => {
        const a = store.push(mkFrame("in", KEY_A, 1));
        const b = store.push(mkFrame("out", KEY_B, 2));
        expect(a.id).not.toBe(b.id);
        expect(store.list()).toHaveLength(2);
    });

    it("wraps around when capacity is exceeded (ring buffer)", () => {
        for (let i = 0; i < 7; i++) store.push(mkFrame("in", KEY_A, i));
        const list = store.list();
        expect(list).toHaveLength(5);
        expect(list[0].timestamp).toBe(2);
        expect(list[4].timestamp).toBe(6);
    });

    it("filters by direction", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("out", KEY_B, 2));
        store.push(mkFrame("in", KEY_A, 3));
        expect(store.list({ direction: "in" })).toHaveLength(2);
        expect(store.list({ direction: "out" })).toHaveLength(1);
    });

    it("filters by substring on className and ns", () => {
        store.push(mkFrame("in", { ns: "A.B", className: "Foo" }, 1));
        store.push(mkFrame("in", { ns: "A.C", className: "Bar" }, 2));
        expect(store.list({ filter: "Foo" })).toHaveLength(1);
        expect(store.list({ filter: "A.C" })).toHaveLength(1);
        expect(store.list({ filter: "zzz" })).toHaveLength(0);
    });

    it("paginates with sinceId (returns frames after the given id)", () => {
        const a = store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("in", KEY_A, 2));
        store.push(mkFrame("in", KEY_A, 3));
        const after = store.list({ sinceId: a.id });
        expect(after).toHaveLength(2);
    });

    it("byType filters frames matching the typeKey", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.push(mkFrame("in", KEY_B, 2));
        store.push(mkFrame("in", KEY_A, 3));
        const list = store.byType(KEY_A, 10);
        expect(list).toHaveLength(2);
        expect(list[0].typeKey.className).toBe("MapMovement");
    });

    it("clear empties the store", () => {
        store.push(mkFrame("in", KEY_A, 1));
        store.clear();
        expect(store.list()).toHaveLength(0);
        expect(store.count()).toBe(0);
    });

    it("emits frame-added when pushing", () => {
        const seen: NetworkFrame[] = [];
        store.on("frame-added", (f: NetworkFrame) => seen.push(f));
        store.push(mkFrame("in", KEY_A, 1));
        expect(seen).toHaveLength(1);
    });

    it("emits cleared when clearing", () => {
        let count = 0;
        store.on("cleared", () => { count++; });
        store.push(mkFrame("in", KEY_A, 1));
        store.clear();
        expect(count).toBe(1);
    });

    it("respects limit option", () => {
        for (let i = 0; i < 5; i++) store.push(mkFrame("in", KEY_A, i));
        expect(store.list({ limit: 3 })).toHaveLength(3);
    });
});
