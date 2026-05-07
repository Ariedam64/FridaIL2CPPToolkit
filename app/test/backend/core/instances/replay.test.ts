import { describe, it, expect, beforeEach } from "vitest";
import { replayRecipe } from "../../../../backend/core/instances/replay";
import { InstanceRegistry } from "../../../../backend/core/instances/instance-registry";
import type { Recipe, RecipeStep } from "../../../../backend/core/instances/types";

interface MockAgent {
    captureViaGC: (className: string, index: number, asKey: string) => Promise<{ className: string; handle: string }>;
    captureViaHook: (className: string, tickMethod: string, timeoutMs: number, asKey: string) => Promise<{ className: string; handle: string }>;
    captureFieldValue: (ownerKey: string, fieldName: string, asKey: string) => Promise<{ className: string; handle: string }>;
    captureListElement: (listClassName: string, listFieldName: string, index: number, asKey: string) => Promise<{ className: string; handle: string }>;
    captureMethodReturn: (ownerKey: string, methodName: string, args: unknown[], asKey: string) => Promise<{ className: string; handle: string }>;
}

const okAgent: MockAgent = {
    captureViaGC: async (cn, _idx, _ak) => ({ className: cn, handle: "0xGC" }),
    captureViaHook: async (cn, _tm, _ms, _ak) => ({ className: cn, handle: "0xHK" }),
    captureFieldValue: async () => ({ className: "Inner", handle: "0xFV" }),
    captureListElement: async () => ({ className: "Item", handle: "0xLE" }),
    captureMethodReturn: async () => ({ className: "Ret", handle: "0xMR" }),
};

const recipe = (steps: RecipeStep[]): Recipe => ({
    id: "r1", name: "test", steps,
    createdAt: "2026-05-07T00:00:00Z",
    updatedAt: "2026-05-07T00:00:00Z",
});

describe("replayRecipe", () => {
    let reg: InstanceRegistry;
    beforeEach(() => { reg = new InstanceRegistry(); });

    it("executes all steps in order on the success path", async () => {
        const order: string[] = [];
        const agent: MockAgent = {
            ...okAgent,
            captureViaGC: async (cn, _idx, _ak) => { order.push(`GC:${cn}`); return { className: cn, handle: "0x1" }; },
            captureFieldValue: async (_o, f) => { order.push(`FV:${f}`); return { className: "I", handle: "0x2" }; },
        };
        const r = recipe([
            { op: "captureViaGC", className: "Player", index: 0, asKey: "player" },
            { op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(order).toEqual(["GC:Player", "FV:inv"]);
        expect(result.finalStatus).toBe("ok");
        expect(reg.get("player")?.handle).toBe("0x1");
        expect(reg.get("inv")?.handle).toBe("0x2");
    });

    it("continues after a failed step (best-effort)", async () => {
        const agent: MockAgent = {
            ...okAgent,
            captureFieldValue: async () => { throw new Error("boom"); },
        };
        const r = recipe([
            { op: "captureViaGC", className: "Player", index: 0, asKey: "player" },
            { op: "captureFieldValue", ownerKey: "player", fieldName: "inv", asKey: "inv" },
            { op: "captureViaGC", className: "Other", index: 0, asKey: "other" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(result.steps[0].ok).toBe(true);
        expect(result.steps[1].ok).toBe(false);
        expect(result.steps[1].error).toContain("boom");
        expect(result.steps[2].ok).toBe(true);
        expect(result.finalStatus).toBe("partial");
        expect(reg.get("player")).not.toBeNull();
        expect(reg.get("inv")).toBeNull();
        expect(reg.get("other")).not.toBeNull();
    });

    it("step referencing missing asKey errors structurally", async () => {
        const r = recipe([
            { op: "captureFieldValue", ownerKey: "doesnotexist", fieldName: "x", asKey: "y" },
        ]);
        const result = await replayRecipe(r, okAgent, reg);
        expect(result.steps[0].ok).toBe(false);
        expect(result.steps[0].error).toContain("doesnotexist");
        expect(result.finalStatus).toBe("failed");
    });

    it("finalStatus = failed when all steps fail", async () => {
        const agent: MockAgent = {
            ...okAgent,
            captureViaGC: async (_cn, _idx, _ak) => { throw new Error("nope"); },
        };
        const r = recipe([
            { op: "captureViaGC", className: "A", index: 0, asKey: "a" },
            { op: "captureViaGC", className: "B", index: 0, asKey: "b" },
        ]);
        const result = await replayRecipe(r, agent, reg);
        expect(result.finalStatus).toBe("failed");
    });
});
