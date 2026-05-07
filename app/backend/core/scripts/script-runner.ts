import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { validateParamValues } from "./param-validator";
import type { ScriptLoader } from "./script-loader";
import type { Toolkit, RunResult, ScriptLog, ScriptDefinition } from "./types";
import type { ToolkitDeps } from "./toolkit-api";

interface RunnerDeps {
    instanceRegistry: ToolkitDeps["instanceRegistry"];
    hookStore: ToolkitDeps["hookStore"];
    frameStore: ToolkitDeps["frameStore"];
    agentCall: ToolkitDeps["agentCall"];
    resolveLabel: ToolkitDeps["resolveLabel"];
}

type BuildToolkit = (deps: ToolkitDeps) => Toolkit;

const DEFAULT_TIMEOUT_MS = 30_000;
const TIMEOUT_SENTINEL = Symbol("timeout");

export class ScriptRunner extends EventEmitter {
    private running = new Map<string, string>();   // scriptId → runId currently running
    private waiters = new Map<string, Promise<void>>();  // runId → promise

    constructor(
        private readonly loader: Pick<ScriptLoader, "getDefinition" | "get">,
        private readonly deps: RunnerDeps,
        private readonly buildToolkit: BuildToolkit,
    ) {
        super();
    }

    /** Resolves the runId once the script has STARTED (not finished). */
    async start(scriptId: string, paramValues: Record<string, unknown>): Promise<{ runId: string }> {
        const def = this.loader.getDefinition(scriptId);
        if (!def) throw new Error(`script not found: ${scriptId}`);

        const validated = validateParamValues(def.params, paramValues);
        if (!validated.ok) throw new Error(validated.error);

        if (this.running.has(scriptId)) {
            throw new Error(`script '${scriptId}' is already running`);
        }

        const runId = randomUUID();
        this.running.set(scriptId, runId);

        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        const done = (async () => {
            const emitLog = (log: Omit<ScriptLog, "runId" | "ts">): void => {
                const event: ScriptLog = { ...log, runId, ts: new Date().toISOString() };
                this.emit("log", event);
            };

            const toolkit = this.buildToolkit({ ...this.deps, runId, emitLog });

            const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            let timer: ReturnType<typeof setTimeout> | null = null;
            const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
                timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
            });

            let result: RunResult;
            try {
                const winner = await Promise.race([
                    def.run(validated.values, toolkit),
                    timeoutPromise,
                ]);
                if (timer) clearTimeout(timer);

                if (winner === TIMEOUT_SENTINEL) {
                    result = { runId, scriptId, status: "timeout", startedAt, durationMs: Date.now() - t0 };
                } else {
                    try {
                        const serialized = JSON.parse(JSON.stringify(winner ?? null));
                        result = { runId, scriptId, status: "ok", result: serialized, startedAt, durationMs: Date.now() - t0 };
                    } catch (err) {
                        result = {
                            runId, scriptId, status: "error",
                            error: { message: `result not serializable: ${(err as Error).message}` },
                            startedAt, durationMs: Date.now() - t0,
                        };
                    }
                }
            } catch (err) {
                if (timer) clearTimeout(timer);
                const e = err as Error;
                result = {
                    runId, scriptId, status: "error",
                    error: { message: e.message, stack: e.stack },
                    startedAt, durationMs: Date.now() - t0,
                };
            } finally {
                this.running.delete(scriptId);
                this.waiters.delete(runId);
            }

            this.emit("result", result);
        })();

        this.waiters.set(runId, done);
        return { runId };
    }

    /** Wait until a specific run has completed (resolved or errored). */
    waitFor(runId: string): Promise<void> {
        return this.waiters.get(runId) ?? Promise.resolve();
    }

    isRunning(scriptId: string): boolean {
        return this.running.has(scriptId);
    }
}
