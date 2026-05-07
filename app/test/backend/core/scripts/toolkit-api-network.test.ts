import { describe, it, expect, vi } from "vitest";
import { FrameStore } from "../../../../backend/core/network/frame-store";
import type { NetworkFrame } from "../../../../backend/core/network/types";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";

function makeDeps(frameStore: FrameStore | null = null): ToolkitDeps {
    return {
        runId: "r1",
        instanceRegistry: null,
        hookStore: null,
        frameStore,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l) => l,
        emitLog: vi.fn(),
    };
}

function mkFrame(messageType: string, direction: "in" | "out", ts = 1): Omit<NetworkFrame, "id"> {
    return {
        timestamp: ts,
        direction,
        typeKey: { ns: null, className: messageType },
        fields: [],
    };
}

describe("toolkit.network", () => {
    it("send delegates to agentCall('sendPacket', ...)", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await toolkit.network.send("Login", { user: "x" });
        expect(deps.agentCall).toHaveBeenCalledWith("sendPacket", ["Login", { user: "x" }]);
    });

    it("recent reads from FrameStore filtered by messageType", async () => {
        const fs = new FrameStore(10);
        fs.push(mkFrame("A", "in",  1));
        fs.push(mkFrame("B", "out", 2));
        fs.push(mkFrame("A", "in",  3));

        const toolkit = buildToolkit(makeDeps(fs));
        const a = await toolkit.network.recent("A");
        expect(a).toHaveLength(2);
        expect(a.map((p) => p.messageType)).toEqual(["A", "A"]);
    });

    it("recent without filter returns all up to limit", async () => {
        const fs = new FrameStore(10);
        for (let i = 0; i < 5; i++) {
            fs.push(mkFrame(`M${i}`, "in", i));
        }
        const toolkit = buildToolkit(makeDeps(fs));
        const r = await toolkit.network.recent(undefined, 3);
        expect(r).toHaveLength(3);
    });

    it("onceReceive resolves on next matching frame", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        const promise = toolkit.network.onceReceive("Hello");

        setTimeout(() => fs.push(mkFrame("Hello", "in", 100)), 10);

        const pkt = await promise;
        expect(pkt.messageType).toBe("Hello");
    });

    it("onceReceive rejects on timeout", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        await expect(toolkit.network.onceReceive("Never", { timeoutMs: 50 }))
            .rejects.toThrow(/timeout/);
    });

    it("send throws if not attached (agentCall always fails)", async () => {
        const deps = { ...makeDeps(), agentCall: vi.fn(async () => { throw new Error("not attached"); }) };
        const toolkit = buildToolkit(deps);
        await expect(toolkit.network.send("X", {})).rejects.toThrow(/not attached/);
    });

    it("recent throws if no frameStore", async () => {
        const toolkit = buildToolkit(makeDeps(null));
        await expect(toolkit.network.recent()).rejects.toThrow(/not attached/);
    });

    it("onceReceive throws if no frameStore", async () => {
        const toolkit = buildToolkit(makeDeps(null));
        await expect(toolkit.network.onceReceive("X", { timeoutMs: 10 })).rejects.toThrow(/not attached/);
    });

    it("onceReceive ignores frames with non-matching messageType", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        const promise = toolkit.network.onceReceive("Target", { timeoutMs: 80 });

        // Push a non-matching frame — should NOT resolve the promise
        setTimeout(() => fs.push(mkFrame("Other", "in", 10)), 10);

        await expect(promise).rejects.toThrow(/timeout/);
    });

    it("recent returns empty array when filter matches nothing", async () => {
        const fs = new FrameStore(10);
        fs.push(mkFrame("A", "in", 1));
        const toolkit = buildToolkit(makeDeps(fs));
        expect(await toolkit.network.recent("Nothing")).toEqual([]);
    });

    it("recent applies limit AFTER messageType filter (not scan window)", async () => {
        const fs = new FrameStore(100);
        // Push 5 "A" frames first, then 50 "B" frames. With a default limit of 100 the "A" frames
        // are still inside the buffer; with limit-then-filter semantic, asking for recent("A", 3)
        // would find at most 3. Filter-then-limit semantic returns all 5 (capped at 3) regardless of B count.
        for (let i = 0; i < 5; i++)  fs.push(mkFrame("A", "in", i));
        for (let i = 0; i < 50; i++) fs.push(mkFrame("B", "out", i + 5));
        const toolkit = buildToolkit(makeDeps(fs));
        const r = await toolkit.network.recent("A", 3);
        expect(r).toHaveLength(3);  // 3 most recent "A" frames (limit applied after filter)
        expect(r.every((p) => p.messageType === "A")).toBe(true);
    });

    it("messageType includes namespace prefix when typeKey.ns is non-null", async () => {
        const fs = new FrameStore(10);
        // Push a frame with namespace
        fs.push({ direction: "in", timestamp: 1, typeKey: { ns: "Ankama.Game", className: "Login" }, fields: [] } as never);
        const toolkit = buildToolkit(makeDeps(fs));
        const r = await toolkit.network.recent();
        expect(r[0].messageType).toBe("Ankama.Game.Login");
    });

    it("onceReceive matches qualified messageType", async () => {
        const fs = new FrameStore(10);
        const toolkit = buildToolkit(makeDeps(fs));
        const promise = toolkit.network.onceReceive("Ankama.Game.Login");
        setTimeout(() => fs.push({
            direction: "in", timestamp: 100,
            typeKey: { ns: "Ankama.Game", className: "Login" }, fields: [{ name: "ok", value: true } as never],
        } as never), 10);
        const pkt = await promise;
        expect(pkt.messageType).toBe("Ankama.Game.Login");
    });
});
