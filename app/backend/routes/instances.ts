import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { replayRecipe, type ReplayAgent } from "../core/instances/replay.js";

export interface InstancesDeps {
    session: {
        instanceRegistry: () => import("../core/instances/instance-registry.js").InstanceRegistry | null;
        historyStore: () => import("../core/instances/history-store.js").HistoryStore | null;
        recipeStore: () => import("../core/instances/recipe-store.js").RecipeStore | null;
        agentCall: (method: string, args: unknown[]) => Promise<unknown>;
        getReadOnly: () => boolean;
        setReadOnly: (v: boolean) => void;
        emit: (event: string, ...args: unknown[]) => boolean;
    };
}

function parseAgentSummary(raw: string): { className: string; handle: string } {
    const m = raw.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
    if (m) return { className: m[1], handle: m[2] };
    return { className: "Unknown", handle: raw };
}

export function mountInstances(app: Express, deps: InstancesDeps): void {
    // -----------------------------------------------------------------------
    // Task 7: list / capture / delete
    // -----------------------------------------------------------------------

    app.get("/api/instances/list", (_req, res) => {
        const reg = deps.session.instanceRegistry();
        res.json({ instances: reg ? reg.list() : [] });
    });

    app.post("/api/instances/capture", async (req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "no session" }); return; }
        const body = req.body ?? {};
        const op = body.op;
        try {
            let summary: string;
            switch (op) {
                case "captureViaGC":
                    summary = String(await deps.session.agentCall("captureViaGC", [body.className, body.index, body.asKey]));
                    break;
                case "captureViaHook":
                    summary = String(await deps.session.agentCall("capture", [body.className, body.tickMethod, body.timeoutMs, body.asKey]));
                    break;
                case "captureFieldValue":
                    summary = String(await deps.session.agentCall("captureFieldValue", [body.ownerKey, body.fieldName, body.asKey]));
                    break;
                case "captureListElement":
                    summary = String(await deps.session.agentCall("captureListElement", [body.ownerKey, body.listFieldName, body.index, body.asKey]));
                    break;
                case "captureMethodReturn":
                    summary = String(await deps.session.agentCall("captureMethodReturn", [body.ownerKey, body.methodName, body.args ?? [], body.asKey]));
                    break;
                default:
                    res.status(400).json({ error: `unknown op: ${op}` });
                    return;
            }
            const { className, handle } = parseAgentSummary(summary);
            reg.set(body.asKey, className, handle, op);
            deps.session.emit("instance-registry-changed");
            res.json({ key: body.asKey, summary });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // NOTE: DELETE /api/instances/history (Task 10) must be registered before
    // DELETE /api/instances/:key so Express does not treat "history" as :key.

    app.get("/api/instances/history", (_req, res) => {
        const h = deps.session.historyStore();
        res.json({ entries: h ? h.list() : [] });
    });

    app.delete("/api/instances/history", (_req, res) => {
        const h = deps.session.historyStore();
        if (!h) { res.status(503).json({ error: "no session" }); return; }
        h.clear();
        deps.session.emit("instance-history-changed");
        res.json({ ok: true });
    });

    app.delete("/api/instances/:key", (req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "no session" }); return; }
        if (!reg.get(req.params.key)) { res.status(404).json({ error: "not found" }); return; }
        reg.delete(req.params.key);
        deps.session.emit("instance-registry-changed");
        res.json({ ok: true });
    });

    // -----------------------------------------------------------------------
    // Task 8: read-fields / write-field / call
    // -----------------------------------------------------------------------

    app.post("/api/instances/:key/read-fields", async (req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "no session" }); return; }
        const inst = reg.get(req.params.key);
        if (!inst) { res.status(404).json({ error: "not found" }); return; }
        try {
            const fields = await deps.session.agentCall("readAllFieldsStructured", [req.params.key]);
            if (!inst.isAlive) reg.setAlive(req.params.key, true);
            res.json({ alive: true, fields });
        } catch (err) {
            reg.setAlive(req.params.key, false);
            res.json({ alive: false, fields: [], error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/instances/:key/write-field", async (req, res) => {
        const reg = deps.session.instanceRegistry();
        const hist = deps.session.historyStore();
        if (!reg || !hist) { res.status(503).json({ error: "no session" }); return; }
        if (deps.session.getReadOnly()) { res.status(403).json({ error: "read-only mode active" }); return; }
        const inst = reg.get(req.params.key);
        if (!inst) { res.status(404).json({ error: "not found" }); return; }
        const { fieldName, value } = req.body ?? {};
        if (typeof fieldName !== "string") { res.status(400).json({ error: "fieldName required" }); return; }

        let before = "?";
        let after = "?";
        let success = false;
        let errorMsg: string | undefined;
        try {
            before = String(await deps.session.agentCall("readField", [req.params.key, fieldName]));
            await deps.session.agentCall("writeField", [req.params.key, fieldName, value]);
            after = String(await deps.session.agentCall("readField", [req.params.key, fieldName]));
            success = true;
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
        }

        hist.append({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            action: "write",
            target: { instanceKey: req.params.key, member: fieldName },
            before, after, success, error: errorMsg,
        });
        deps.session.emit("instance-history-changed");

        if (!success) { res.status(500).json({ error: errorMsg }); return; }
        res.json({ before, after });
    });

    app.post("/api/instances/:key/call", async (req, res) => {
        const reg = deps.session.instanceRegistry();
        const hist = deps.session.historyStore();
        if (!reg || !hist) { res.status(503).json({ error: "no session" }); return; }
        if (deps.session.getReadOnly()) { res.status(403).json({ error: "read-only mode active" }); return; }
        const inst = reg.get(req.params.key);
        if (!inst) { res.status(404).json({ error: "not found" }); return; }
        const { methodName, args } = req.body ?? {};
        if (typeof methodName !== "string") { res.status(400).json({ error: "methodName required" }); return; }

        let callResult = "?";
        let success = false;
        let errorMsg: string | undefined;
        try {
            callResult = String(await deps.session.agentCall("callInstance", [req.params.key, methodName, args ?? []]));
            success = true;
        } catch (err) {
            errorMsg = err instanceof Error ? err.message : String(err);
        }

        hist.append({
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            action: "call",
            target: { instanceKey: req.params.key, member: methodName },
            callArgs: args ?? [],
            callResult,
            success,
            error: errorMsg,
        });
        deps.session.emit("instance-history-changed");

        if (!success) { res.status(500).json({ error: errorMsg }); return; }
        res.json({ result: callResult });
    });

    // -----------------------------------------------------------------------
    // Task 9: read-only toggle + recipes CRUD
    // -----------------------------------------------------------------------

    app.get("/api/instances/read-only", (_req, res) => {
        res.json({ enabled: deps.session.getReadOnly() });
    });

    app.post("/api/instances/read-only", (req, res) => {
        const enabled = !!(req.body?.enabled);
        deps.session.setReadOnly(enabled);
        deps.session.emit("read-only-changed");
        res.json({ enabled });
    });

    app.get("/api/instances/recipes", (_req, res) => {
        const rs = deps.session.recipeStore();
        res.json({ recipes: rs ? rs.list() : [] });
    });

    app.post("/api/instances/recipes", (req, res) => {
        const rs = deps.session.recipeStore();
        if (!rs) { res.status(503).json({ error: "no session" }); return; }
        const { name, steps, description } = req.body ?? {};
        if (typeof name !== "string" || !Array.isArray(steps)) {
            res.status(400).json({ error: "name (string) + steps (array) required" });
            return;
        }
        const recipe = rs.add(name, steps, description);
        deps.session.emit("recipe-store-changed");
        res.json({ recipe });
    });

    app.put("/api/instances/recipes/:id", (req, res) => {
        const rs = deps.session.recipeStore();
        if (!rs) { res.status(503).json({ error: "no session" }); return; }
        if (!rs.get(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
        rs.update(req.params.id, req.body ?? {});
        deps.session.emit("recipe-store-changed");
        res.json({ recipe: rs.get(req.params.id) });
    });

    app.delete("/api/instances/recipes/:id", (req, res) => {
        const rs = deps.session.recipeStore();
        if (!rs) { res.status(503).json({ error: "no session" }); return; }
        if (!rs.get(req.params.id)) { res.status(404).json({ error: "not found" }); return; }
        rs.delete(req.params.id);
        deps.session.emit("recipe-store-changed");
        res.json({ ok: true });
    });

    // -----------------------------------------------------------------------
    // Task 10: recipe replay
    // -----------------------------------------------------------------------

    app.post("/api/instances/recipes/:id/replay", async (req, res) => {
        const rs = deps.session.recipeStore();
        const reg = deps.session.instanceRegistry();
        if (!rs || !reg) { res.status(503).json({ error: "no session" }); return; }
        const recipe = rs.get(req.params.id);
        if (!recipe) { res.status(404).json({ error: "not found" }); return; }

        const parse = (raw: string): { className: string; handle: string } => {
            const m = raw.match(/^(.+?)@(0x[0-9a-fA-F]+)/);
            return m ? { className: m[1], handle: m[2] } : { className: "Unknown", handle: raw };
        };
        const agent: ReplayAgent = {
            captureViaGC: async (cn, idx, ak) => parse(String(await deps.session.agentCall("captureViaGC", [cn, idx, ak]))),
            captureViaHook: async (cn, tm, ms, ak) => parse(String(await deps.session.agentCall("capture", [cn, tm, ms, ak]))),
            captureFieldValue: async (ok, fn, ak) => parse(String(await deps.session.agentCall("captureFieldValue", [ok, fn, ak]))),
            captureListElement: async (cn, fn, idx, ak) => parse(String(await deps.session.agentCall("captureListElement", [cn, fn, idx, ak]))),
            captureMethodReturn: async (ok, mn, args, ak) => parse(String(await deps.session.agentCall("captureMethodReturn", [ok, mn, args, ak]))),
        };

        const result = await replayRecipe(recipe, agent, reg);
        rs.update(recipe.id, {
            lastReplayedAt: new Date().toISOString(),
            lastReplayStatus: result.finalStatus,
        });
        deps.session.emit("instance-registry-changed");
        deps.session.emit("recipe-store-changed");
        res.json(result);
    });
}
