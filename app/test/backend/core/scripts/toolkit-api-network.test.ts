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
});
