import { describe, it, expect, vi } from "vitest";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";
import type { CapturedInstance } from "../../../../backend/core/instances/types";

function makeDeps(overrides?: Partial<ToolkitDeps>): ToolkitDeps {
    const captured: CapturedInstance[] = [];
    const registry = {
        list: () => captured,
        get: (k: string) => captured.find((c) => c.key === k) ?? null,
        set: vi.fn(),
        delete: vi.fn(),
    } as unknown as ToolkitDeps["instanceRegistry"];

    return {
        runId: "r1",
        instanceRegistry: registry,
        hookStore: null,
        frameStore: null,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l: string) => l,    // identity (no labels in tests)
        emitLog: vi.fn(),
        ...overrides,
    };
}

describe("toolkit.instances", () => {
    it("find resolves friendly label and returns single matching captured instance", async () => {
        const deps = makeDeps();
        (deps.instanceRegistry as { list: () => CapturedInstance[] }).list = () => [
            { key: "p", className: "PlayerManager", handle: "0xa", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
        ];
        deps.resolveLabel = (l) => l === "PlayerManager" ? "fzc" : l;
        const toolkit = buildToolkit(deps);
        const h = await toolkit.instances.find("PlayerManager");
        expect(h.className).toBe("PlayerManager");
        expect(h.handle).toBe("0xa");
    });

    it("find throws if no match", async () => {
        const toolkit = buildToolkit(makeDeps());
        await expect(toolkit.instances.find("Nope")).rejects.toThrow(/no captured instance.*Nope/);
    });

    it("find throws if N>1 match", async () => {
        const deps = makeDeps();
        (deps.instanceRegistry as { list: () => CapturedInstance[] }).list = () => [
            { key: "a", className: "X", handle: "0x1", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
            { key: "b", className: "X", handle: "0x2", capturedAt: "", capturedVia: "captureViaGC", isAlive: true },
        ];
        const toolkit = buildToolkit(deps);
        await expect(toolkit.instances.find("X")).rejects.toThrow(/2 matches/);
    });

    it("read calls agent with class+field+handle", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => 42) });
        const toolkit = buildToolkit(deps);
        const v = await toolkit.instances.read({ className: "C", handle: "0xa", key: "k" }, "kamas");
        expect(v).toBe(42);
        expect(deps.agentCall).toHaveBeenCalledWith("readField", ["C", "0xa", "kamas"]);
    });

    it("call calls agent with method + args", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => "ok") });
        const toolkit = buildToolkit(deps);
        const r = await toolkit.instances.call(
            { className: "C", handle: "0xa", key: "k" }, "TravelTo", [12345],
        );
        expect(r).toBe("ok");
        expect(deps.agentCall).toHaveBeenCalledWith("callMethod", ["C", "0xa", "TravelTo", [12345]]);
    });

    it("capture invokes agent + records into registry", async () => {
        const deps = makeDeps({ agentCall: vi.fn(async () => "X@0xbeef") });
        const toolkit = buildToolkit(deps);
        const h = await toolkit.instances.capture("X");
        expect(h.className).toBe("X");
        expect(h.handle).toBe("0xbeef");
        expect((deps.instanceRegistry as { set: (...a: unknown[]) => void }).set).toHaveBeenCalled();
    });
});
