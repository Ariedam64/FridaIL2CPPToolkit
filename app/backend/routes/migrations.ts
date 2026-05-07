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

        // If a class was accepted, trigger pass 2 (members migrate now).
        let pass2Records: ReturnType<typeof deps.session.applyClassPass2> | null = null;
        if (key.kind === "class") {
            pass2Records = deps.session.applyClassPass2(entry.oldObf, key.className);
        }

        deps.session.emit("migration-updated");
        res.json({ ok: true, pass2: pass2Records });
        return;
    });

    app.post("/api/migrations/reject", (req, res) => {
        const m = deps.session.migrations();
        if (!m) { res.status(503).json({ error: "no migrations" }); return; }

        const body = req.body ?? {};
        let key: LabelKey;
        let oldObf: string;
        if (body.key && typeof body.oldObf === "string") {
            key = body.key as LabelKey;
            oldObf = body.oldObf;
        } else if (typeof body.oldObf === "string") {
            key = { kind: "class", className: body.oldObf };
            oldObf = body.oldObf;
        } else {
            res.status(400).json({ error: "expected {key,oldObf} or {oldObf}" });
            return;
        }

        const idx = m.result.review.findIndex((r) => r.oldObf === oldObf);
        if (idx < 0) { res.status(404).json({ error: "no pending review" }); return; }
        const entry = m.result.review[idx];
        m.result.review.splice(idx, 1);
        m.result.lost.push({
            key,
            label: entry.label,
            oldObf: entry.oldObf,
            reason: "user rejected",
            parentClassMigration: entry.parentClassMigration,
        });

        let cascaded: import("../core/types.js").MigrationLostRecord[] = [];
        if (key.kind === "class") {
            cascaded = deps.session.applyClassRejectCascade(entry.oldObf);
        }

        deps.session.emit("migration-updated");
        res.json({ ok: true, cascaded });
    });

    app.post("/api/migrations/accept-top-all", (_req, res) => {
        const p = deps.session.profile();
        const m = deps.session.migrations();
        if (!p || !m) { res.status(503).json({ error: "no migrations or no profile" }); return; }

        let accepted = 0;
        // Iterate on a snapshot — we mutate review[] inside the loop.
        const snapshot = m.result.review.slice();
        for (const entry of snapshot) {
            if (entry.candidates.length === 0) continue;
            const top = entry.candidates[0];

            // Build the destination LabelKey from the entry's key shape + top.newObf.
            let destKey: LabelKey;
            if (entry.key.kind === "class") {
                destKey = { kind: "class", className: top.newObf };
            } else if (entry.key.kind === "method") {
                const dot = top.newObf.lastIndexOf(".");
                destKey = { kind: "method", className: top.newObf.slice(0, dot), methodName: top.newObf.slice(dot + 1) };
            } else {
                const dot = top.newObf.lastIndexOf(".");
                destKey = { kind: "field", className: top.newObf.slice(0, dot), fieldName: top.newObf.slice(dot + 1) };
            }

            p.labels.set(destKey, entry.label);
            const idx = m.result.review.findIndex((r) => r.oldObf === entry.oldObf);
            if (idx >= 0) m.result.review.splice(idx, 1);
            m.result.auto.push({
                key: destKey,
                label: entry.label,
                oldObf: entry.oldObf,
                newObf: top.newObf,
                reason: "user accepted (bulk top)",
                parentClassMigration: entry.parentClassMigration,
            });
            if (destKey.kind === "class") {
                deps.session.applyClassPass2(entry.oldObf, destKey.className);
            }
            accepted++;
        }
        p.labels.scheduleFlush();
        deps.session.emit("migration-updated");
        res.json({ ok: true, acceptedCount: accepted });
    });
}
