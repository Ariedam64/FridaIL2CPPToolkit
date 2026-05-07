// app/backend/routes/migrations.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

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

        // Accept either:
        //   v1.3 polymorphic: { key: LabelKey, oldObf: string }
        //   v1.2 legacy:      { oldObf: string, newObf: string }   (assumed class)
        const body = req.body ?? {};
        let key: LabelKey;
        let oldObf: string;
        if (body.key && typeof body.oldObf === "string") {
            key = body.key as LabelKey;
            oldObf = body.oldObf;
        } else if (typeof body.oldObf === "string" && typeof body.newObf === "string") {
            key = { kind: "class", className: body.newObf };
            oldObf = body.oldObf;
        } else {
            res.status(400).json({ error: "expected {key,oldObf} or {oldObf,newObf}" });
            return;
        }

        const idx = m.result.review.findIndex((r) => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];

        p.labels.set(key, entry.label);
        p.labels.scheduleFlush();
        m.result.review.splice(idx, 1);

        // Compute newObf for the AUTO record
        const newObf =
            key.kind === "class"  ? key.className
          : key.kind === "method" ? `${key.className}.${key.methodName}`
          : `${key.className}.${key.fieldName}`;

        m.result.auto.push({
            key,
            label: entry.label,
            oldObf: entry.oldObf,
            newObf,
            reason: "user accepted",
            parentClassMigration: entry.parentClassMigration,
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
