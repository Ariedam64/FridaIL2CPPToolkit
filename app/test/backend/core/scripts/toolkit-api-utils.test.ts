import { describe, it, expect, vi } from "vitest";
import { buildToolkit } from "../../../../backend/core/scripts/toolkit-api";

const baseDeps = () => ({
    runId: "r1",
    instanceRegistry: null,
    hookStore: null,
    frameStore: null,
    agentCall: vi.fn(async () => null),
    resolveLabel: (l: string) => l,
    emitLog: vi.fn(),
});

describe("toolkit utils", () => {
    it("log/warn/error emit logs with right level", () => {
        const deps = baseDeps();
        const toolkit = buildToolkit(deps);
        toolkit.log("hi", 42);
        toolkit.warn("warn");
        toolkit.error(new Error("oops"));
        expect(deps.emitLog).toHaveBeenCalledTimes(3);
        expect(deps.emitLog).toHaveBeenNthCalledWith(1, { level: "info",  args: ["hi", 42] });
        expect(deps.emitLog).toHaveBeenNthCalledWith(2, { level: "warn",  args: ["warn"] });
        expect(deps.emitLog.mock.calls[2][0].level).toBe("error");
    });

    it("sleep waits ~the given duration", async () => {
        const toolkit = buildToolkit(baseDeps());
        const t0 = Date.now();
        await toolkit.sleep(60);
        const dt = Date.now() - t0;
        expect(dt).toBeGreaterThanOrEqual(50);
    });
});
