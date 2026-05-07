import type { Express } from "express";
import type { ScriptLoader } from "../core/scripts/script-loader";
import type { ScriptRunner } from "../core/scripts/script-runner";
import { ScriptValidationError } from "../core/scripts/script-runner";

export interface ScriptsDeps {
    loader: () => Pick<ScriptLoader, "list" | "get" | "getDefinition"> | null;
    runner: () => Pick<ScriptRunner, "start" | "isRunning"> | null;
}

export function mountScripts(app: Express, deps: ScriptsDeps): void {
    app.get("/api/scripts", (_req, res) => {
        const loader = deps.loader();
        if (!loader) { res.json({ scripts: [] }); return; }
        // The registry entries already exclude `run` (only the serializable subset is in `definition`).
        res.json({ scripts: loader.list() });
    });

    app.post("/api/scripts/:id/run", async (req, res) => {
        const loader = deps.loader();
        const runner = deps.runner();
        if (!loader || !runner) { res.status(503).json({ error: "not attached" }); return; }

        const id = req.params.id;
        const entry = loader.get(id);
        if (!entry) { res.status(404).json({ error: `script not found: ${id}` }); return; }
        if (entry.status !== "loaded") {
            res.status(422).json({ error: `script in ${entry.status} state: ${entry.error ?? ""}` });
            return;
        }
        if (runner.isRunning(id)) {
            res.status(409).json({ error: `script '${id}' already running` });
            return;
        }

        const params = (req.body?.params ?? {}) as Record<string, unknown>;
        try {
            const { runId } = await runner.start(id, params);
            res.json({ runId });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const status = err instanceof ScriptValidationError ? 400 : 500;
            res.status(status).json({ error: msg });
        }
    });
}
