// app/backend/routes/annotations.ts
import type { Express } from "express";
import type { Session } from "../session.js";
import type { LabelKey } from "../core/types.js";

export interface AnnotationsDeps { session: Session; }

function asKey(raw: any): LabelKey | null {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind === "class" && typeof raw.className === "string") {
        return { kind: "class", className: raw.className };
    }
    if (raw.kind === "method" && typeof raw.className === "string" && typeof raw.methodName === "string") {
        return { kind: "method", className: raw.className, methodName: raw.methodName };
    }
    if (raw.kind === "field" && typeof raw.className === "string" && typeof raw.fieldName === "string") {
        return { kind: "field", className: raw.className, fieldName: raw.fieldName };
    }
    return null;
}

export function mountAnnotations(app: Express, deps: AnnotationsDeps): void {
    function profile() {
        return deps.session.profile();
    }

    app.get("/api/annotations", (_req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const bookmarks = p.annotations.listBookmarks();
        const notes = p.annotations.listNoted().map((key) => ({
            key, markdown: p.annotations.getNote(key) ?? "",
        }));
        res.json({ bookmarks, notes });
    });

    app.post("/api/annotations/bookmark", (req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const key = asKey(req.body?.key);
        if (!key) { res.status(400).json({ error: "invalid key" }); return; }
        p.annotations.toggleBookmark(key);
        p.annotations.scheduleFlush();
        res.json({ ok: true });
    });

    app.post("/api/annotations/note", (req, res) => {
        const p = profile();
        if (!p) { res.status(503).json({ error: "not attached" }); return; }
        const key = asKey(req.body?.key);
        if (!key) { res.status(400).json({ error: "invalid key" }); return; }
        if (req.body?.remove === true) {
            p.annotations.removeNote(key);
        } else {
            if (typeof req.body?.markdown !== "string") {
                res.status(400).json({ error: "markdown required" });
                return;
            }
            p.annotations.setNote(key, req.body.markdown);
        }
        p.annotations.scheduleFlush();
        res.json({ ok: true });
    });
}
