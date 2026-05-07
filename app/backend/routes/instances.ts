import { randomUUID } from "node:crypto";
import type { Express } from "express";

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
                    summary = String(await deps.session.agentCall("captureViaGC", [body.className, body.index]));
                    break;
                case "captureViaHook":
                    summary = String(await deps.session.agentCall("capture", [body.className, body.tickMethod, body.timeoutMs]));
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
}
