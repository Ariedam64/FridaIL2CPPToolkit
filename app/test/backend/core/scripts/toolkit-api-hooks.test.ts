import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { buildToolkit, type ToolkitDeps } from "../../../../backend/core/scripts/toolkit-api";

function makeDeps(): ToolkitDeps & { hookEmitter: EventEmitter } {
    const hookEmitter = new EventEmitter();
    const hookStore = {
        add: vi.fn((spec) => ({ id: "h1", spec, installedHookId: null, addedAt: 1 })),
        install: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        list: () => [],
        onAgentEvent: (listener: (evt: { hookId: string; args: unknown[] }) => void): (() => void) => {
            hookEmitter.on("event", listener);
            return () => hookEmitter.off("event", listener);
        },
    } as unknown as ToolkitDeps["hookStore"];

    return {
        runId: "r1",
        instanceRegistry: null,
        hookStore,
        frameStore: null,
        agentCall: vi.fn(async () => null),
        resolveLabel: (l) => l,
        emitLog: vi.fn(),
        hookEmitter,
    } as ToolkitDeps & { hookEmitter: EventEmitter };
}

describe("toolkit.hooks", () => {
    it("install creates a hook spec and arms it", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        const h = await toolkit.hooks.install("PlayerManager.TakeDamage", { mode: "log" });
        expect(h.id).toBe("h1");
        expect((deps.hookStore as { add: (...a: unknown[]) => void }).add).toHaveBeenCalled();
        expect((deps.hookStore as { install: (...a: unknown[]) => void }).install).toHaveBeenCalledWith("h1");
    });

    it("remove uninstalls + deletes the hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await toolkit.hooks.remove({ id: "abc" });
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalledWith("abc");
    });

    it("onceCall installs hook + resolves on first event + removes hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);

        const promise = toolkit.hooks.onceCall("X.foo", { timeoutMs: 1000 });
        // Simulate an event arriving with the matching hookId.
        setTimeout(() => deps.hookEmitter.emit("event", { hookId: "h1", args: [42] }), 10);

        const evt = await promise;
        expect(evt.args).toEqual([42]);
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalledWith("h1");
    });

    it("onceCall rejects on timeout + removes hook", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        await expect(toolkit.hooks.onceCall("X.never", { timeoutMs: 50 }))
            .rejects.toThrow(/timeout/);
        expect((deps.hookStore as { remove: (...a: unknown[]) => void }).remove).toHaveBeenCalled();
    });

    it("install throws when not attached (no hookStore)", async () => {
        const deps = { ...makeDeps(), hookStore: null };
        const toolkit = buildToolkit(deps);
        await expect(toolkit.hooks.install("X.foo", {})).rejects.toThrow(/not attached/);
    });

    it("onceCall ignores events with non-matching hookId (regression: agent vs stored ID translation)", async () => {
        const deps = makeDeps();
        const toolkit = buildToolkit(deps);
        const promise = toolkit.hooks.onceCall("X.foo", { timeoutMs: 80 });
        // Emit an event with a DIFFERENT hookId — should be ignored, NOT resolve the promise.
        setTimeout(() => deps.hookEmitter.emit("event", { hookId: "DIFFERENT", args: [99] }), 10);
        await expect(promise).rejects.toThrow(/timeout/);
    });
});
