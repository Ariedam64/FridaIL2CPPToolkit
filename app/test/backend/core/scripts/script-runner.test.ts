import { describe, it, expect, beforeEach, vi } from "vitest";
import { ScriptRunner } from "../../../../backend/core/scripts/script-runner";
import type { ScriptDefinition } from "../../../../backend/core/scripts/types";

const fakeLoader = (defs: Record<string, ScriptDefinition>) => ({
    getDefinition: (id: string) => defs[id] ?? null,
    get: (id: string) => (defs[id] ? { id, status: "loaded", definition: defs[id], filePath: "", loadedAt: "" } : null),
});

const fakeBuildToolkit = vi.fn((deps: { emitLog: (l: { level: string; args: unknown[] }) => void }) => ({
    instances: {} as never, hooks: {} as never, network: {} as never,
    log: (...args: unknown[]) => deps.emitLog({ level: "info", args }),
    warn: () => undefined, error: () => undefined, sleep: () => Promise.resolve(),
}));

describe("ScriptRunner", () => {
    let runner: ScriptRunner;
    let logs: unknown[];
    let results: unknown[];

    beforeEach(() => {
        logs = [];
        results = [];
        runner = new ScriptRunner(
            fakeLoader({}) as never,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            fakeBuildToolkit as never,
        );
        runner.on("log",    (l) => logs.push(l));
        runner.on("result", (r) => results.push(r));
    });

    it("runs a valid script and returns the result", async () => {
        const def: ScriptDefinition = {
            name: "echo", params: { msg: { type: "string", required: true } },
            run: async ({ msg }, tk) => { tk.log("got", msg); return `echo:${msg}`; },
        };
        runner = new ScriptRunner(
            fakeLoader({ echo: def }) as never,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            fakeBuildToolkit as never,
        );
        runner.on("log", (l) => logs.push(l));
        runner.on("result", (r) => results.push(r));

        const { runId } = await runner.start("echo", { msg: "hi" });
        await runner.waitFor(runId);

        expect((results[0] as { status: string }).status).toBe("ok");
        expect((results[0] as { result: unknown }).result).toBe("echo:hi");
        expect(logs.length).toBeGreaterThan(0);
    });

    it("rejects invalid params", async () => {
        const def: ScriptDefinition = {
            name: "x", params: { n: { type: "number", required: true } },
            run: async () => null,
        };
        runner = new ScriptRunner(fakeLoader({ x: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        await expect(runner.start("x", {})).rejects.toThrow(/missing required param: n/);
    });

    it("rejects unknown script id", async () => {
        await expect(runner.start("nope", {})).rejects.toThrow(/script not found/);
    });

    it("rejects same script twice concurrently", async () => {
        const def: ScriptDefinition = {
            name: "slow", params: {},
            run: async () => { await new Promise((r) => setTimeout(r, 50)); return "done"; },
        };
        runner = new ScriptRunner(fakeLoader({ slow: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        await runner.start("slow", {});
        await expect(runner.start("slow", {})).rejects.toThrow(/already running/);
    });

    it("respects timeoutMs", async () => {
        const def: ScriptDefinition = {
            name: "tic", params: {}, timeoutMs: 30,
            run: async () => { await new Promise((r) => setTimeout(r, 200)); return "late"; },
        };
        runner = new ScriptRunner(fakeLoader({ tic: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("tic", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string }).status).toBe("timeout");
    });

    it("captures error from script + status 'error'", async () => {
        const def: ScriptDefinition = {
            name: "boom", params: {},
            run: async () => { throw new Error("kaboom"); },
        };
        runner = new ScriptRunner(fakeLoader({ boom: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("boom", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string; error?: { message: string } }).status).toBe("error");
        expect((results[0] as { error?: { message: string } }).error?.message).toMatch(/kaboom/);
    });

    it("rejects non-serializable result", async () => {
        const def: ScriptDefinition = {
            name: "cycle", params: {},
            run: async () => { const o: Record<string, unknown> = {}; o.self = o; return o; },
        };
        runner = new ScriptRunner(fakeLoader({ cycle: def }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("cycle", {});
        await runner.waitFor(runId);
        expect((results[0] as { status: string; error?: { message: string } }).status).toBe("error");
        expect((results[0] as { error?: { message: string } }).error?.message).toMatch(/not serializable/);
    });

    it("allows two different scripts to run in parallel", async () => {
        const a: ScriptDefinition = { name: "a", params: {}, run: async () => { await new Promise((r) => setTimeout(r, 30)); return "a"; } };
        const b: ScriptDefinition = { name: "b", params: {}, run: async () => "b" };
        runner = new ScriptRunner(fakeLoader({ a, b }) as never, { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l }, fakeBuildToolkit as never);
        runner.on("result", (r) => results.push(r));
        const { runId: ra } = await runner.start("a", {});
        const { runId: rb } = await runner.start("b", {});
        await Promise.all([runner.waitFor(ra), runner.waitFor(rb)]);
        expect(results).toHaveLength(2);
    });
});
