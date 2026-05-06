// app/backend/routes/labels.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

export interface LabelsDeps { session: Session; }

function ensureProfile(deps: LabelsDeps) {
    return deps.session.profile();
}

function buildKey(kind: "class" | "method" | "field", raw: any): LabelKey | null {
    if (!raw || typeof raw !== "object") return null;
    if (kind === "class") {
        if (typeof raw.className !== "string") return null;
        return { kind, className: raw.className };
    }
    if (kind === "method") {
        if (typeof raw.className !== "string" || typeof raw.methodName !== "string") return null;
        return { kind, className: raw.className, methodName: raw.methodName };
    }
    if (typeof raw.className !== "string" || typeof raw.fieldName !== "string") return null;
    return { kind, className: raw.className, fieldName: raw.fieldName };
}

export function mountLabels(app: Express, deps: LabelsDeps): void {
    app.get("/api/labels", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        res.json(p.labels.bulkExport());
    });

    for (const kind of ["class", "method", "field"] as const) {
        app.post(`/api/labels/${kind}`, (req, res) => {
            const p = ensureProfile(deps);
            if (!p) { res.status(503).json({ error: "not attached" }); return; }
            const key = buildKey(kind, req.body?.key);
            if (!key) { res.status(400).json({ error: "invalid key" }); return; }
            if (req.body?.remove === true) {
                p.labels.remove(key);
            } else {
                if (typeof req.body?.label !== "string" || req.body.label.length === 0) {
                    res.status(400).json({ error: "label required" });
                    return;
                }
                p.labels.set(key, req.body.label);
            }
            p.labels.scheduleFlush();
            res.json({ ok: true });
        });
    }

    app.post("/api/labels/undo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.undo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });

    app.post("/api/labels/redo", (_req, res) => {
        const p = ensureProfile(deps);
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const ok = p.labels.redo();
        if (ok) p.labels.scheduleFlush();
        res.json({ ok });
    });
}
