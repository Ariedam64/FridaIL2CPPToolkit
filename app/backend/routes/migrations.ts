// app/backend/routes/migrations.ts
import type { Express } from "express";
import type { Session } from "../session.js";

export interface MigrationsDeps { session: Session; }

export function mountMigrations(app: Express, deps: MigrationsDeps): void {
    app.get("/api/migrations", (_req, res) => {
        const m = deps.session.migrations();
        if (!m) { res.json({ result: { auto: [], review: [], lost: [] } }); return; }
        res.json(m);
    });

    app.post("/api/migrations/accept", async (req, res) => {
        const p = deps.session.profile();
        const m = deps.session.migrations();
        if (!p || !m) { res.status(503).json({ error: "no migrations or no profile" }); return; }
        const { oldObf, newObf } = req.body ?? {};
        if (typeof oldObf !== "string" || typeof newObf !== "string") {
            res.status(400).json({ error: "oldObf + newObf required" });
            return;
        }
        const idx = m.result.review.findIndex(r => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];
        p.labels.set({ kind: "class", className: newObf }, entry.label);
        p.labels.scheduleFlush();
        m.result.review.splice(idx, 1);
        m.result.auto.push({
            key: entry.key, label: entry.label, oldObf: entry.oldObf, newObf,
            reason: "user accepted",
        });
        res.json({ ok: true });
    });

    app.post("/api/migrations/reject", (req, res) => {
        const m = deps.session.migrations();
        if (!m) { res.status(503).json({ error: "no migrations" }); return; }
        const { oldObf } = req.body ?? {};
        if (typeof oldObf !== "string") { res.status(400).json({ error: "oldObf required" }); return; }
        const idx = m.result.review.findIndex(r => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];
        m.result.review.splice(idx, 1);
        m.result.lost.push({
            key: entry.key, label: entry.label, oldObf: entry.oldObf,
            reason: "user rejected",
        });
        res.json({ ok: true });
    });
}
