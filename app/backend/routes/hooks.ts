// app/backend/routes/hooks.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import { validateHookSpec } from "../core/hooks/hook-spec-validation.js";

export interface HooksDeps { session: Session; }

export function mountHooks(app: Express, deps: HooksDeps): void {
    function store() { return deps.session.hookStore(); }

    app.get("/api/hooks", (_req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ hooks: s.list() });
    });

    app.post("/api/hooks/add", (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const spec = req.body?.spec;
        const v = validateHookSpec(spec);
        if (!v.ok) { res.status(400).json({ error: v.reason }); return; }
        const stored = s.add(spec);
        res.json({ stored });
    });

    app.post("/api/hooks/update", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        const spec = req.body?.spec;
        const v = validateHookSpec(spec);
        if (typeof id !== "string" || !v.ok) {
            res.status(400).json({ error: v.ok ? "id required" : v.reason });
            return;
        }
        try {
            await s.update(id, spec);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/install", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.install(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/uninstall", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.uninstall(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/remove", async (req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        const id = req.body?.id;
        if (typeof id !== "string") { res.status(400).json({ error: "id required" }); return; }
        try {
            await s.remove(id);
            res.json({ ok: true });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/hooks/clear-all", async (_req, res) => {
        const s = store();
        if (!s) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const r = await deps.session.fridaClient.call<{ count: number }>("clearAllHooks");
            s.markAllDisarmed();
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
