import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { SourceMapConsumer } from "source-map";
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
        private readonly loader: Pick<ScriptLoader, "getDefinition" | "get" | "getCompiled">,
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
            let result: RunResult | undefined;
            let timer: ReturnType<typeof setTimeout> | null = null;

            try {
                const emitLog = (log: Omit<ScriptLog, "runId" | "ts">): void => {
                    const event: ScriptLog = { ...log, runId, ts: new Date().toISOString() };
                    this.emit("log", event);
                };

                const toolkit = this.buildToolkit({ ...this.deps, runId, emitLog });

                const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
                const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
                    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
                });

                const winner = await Promise.race([
                    def.run(validated.values, toolkit),
                    timeoutPromise,
                ]);

                if (winner === TIMEOUT_SENTINEL) {
                    result = { runId, scriptId, status: "timeout", startedAt, durationMs: Date.now() - t0 };
                } else {
                    try {
                        const serialized = JSON.parse(JSON.stringify(winner ?? null));
                        result = { runId, scriptId, status: "ok", result: serialized, startedAt, durationMs: Date.now() - t0 };
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        result = {
                            runId, scriptId, status: "error",
                            error: { message: `result not serializable: ${message}` },
                            startedAt, durationMs: Date.now() - t0,
                        };
                    }
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                let stack    = err instanceof Error ? err.stack   : undefined;

                // Re-map stack to user .ts source if loader can supply the compiled JS + path.
                const loaderWithCompiled = this.loader as { getCompiled?: (id: string) => string | null };
                const compiled = loaderWithCompiled.getCompiled?.(scriptId);
                const entry = this.loader.get(scriptId);
                if (stack && compiled && entry?.filePath) {
                    try { stack = await remapStack(stack, compiled, entry.filePath); }
                    catch { /* fall back to raw stack */ }
                }

                result = {
                    runId, scriptId, status: "error",
                    error: { message, stack },
                    startedAt, durationMs: Date.now() - t0,
                };
            } finally {
                if (timer) clearTimeout(timer);
                this.running.delete(scriptId);
                this.waiters.delete(runId);
            }

            this.emit("result", result!);
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

/** Parse `//# sourceMappingURL=data:application/json;base64,<...>` from compiled JS. */
function extractInlineSourceMap(js: string): string | null {
    const m = js.match(/\/\/# sourceMappingURL=data:application\/json[^,]*,([A-Za-z0-9+/=]+)/);
    if (!m) return null;
    try {
        return Buffer.from(m[1], "base64").toString("utf8");
    } catch {
        return null;
    }
}

/**
 * Re-map each `<anonymous>:LINE:COL` pattern in the stack to the original .ts source.
 *
 * The compiled JS is executed via `new AsyncFunction(...)`. The AsyncFunction constructor
 * prepends a 2-line preamble (`async function anonymous(...\n) {\n`) before the user code,
 * so the line numbers in the stack are offset by +2 relative to the compiled JS.
 * We subtract that offset before looking up the sourcemap.
 */
async function remapStack(stack: string, compiledJs: string, originalPath: string): Promise<string> {
    const rawMap = extractInlineSourceMap(compiledJs);
    if (!rawMap) return stack;
    const consumer = await new SourceMapConsumer(rawMap);
    // AsyncFunction preamble: "async function anonymous(...\n) {\n" = 2 lines before user code.
    const ASYNC_FN_PREAMBLE_LINES = 2;
    try {
        return stack.split("\n").map((line) => {
            const m = line.match(/<anonymous>:(\d+):(\d+)/);
            if (!m) return line;
            const lineNo = parseInt(m[1], 10) - ASYNC_FN_PREAMBLE_LINES;
            const colNo  = parseInt(m[2], 10);
            if (lineNo < 1) return line;
            const orig = consumer.originalPositionFor({ line: lineNo, column: colNo });
            if (orig.source && orig.line) {
                return line.replace(/<anonymous>:\d+:\d+/, `${path.basename(originalPath)}:${orig.line}:${orig.column}`);
            }
            return line;
        }).join("\n");
    } finally {
        consumer.destroy();
    }
}
