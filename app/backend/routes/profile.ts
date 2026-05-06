// app/backend/routes/profile.ts
import type { Express } from "express";
import type { Session } from "../session.js";

export interface ProfileDeps {
    session: Session;
}

function serializeProfile(p: ReturnType<Session["profile"]>) {
    if (!p) return null;
    return {
        manifest: p.manifest,
        rootPath: p.rootPath,
    };
}

export function mountProfile(app: Express, deps: ProfileDeps): void {
    app.get("/api/profile", (_req, res) => {
        res.json({ profile: serializeProfile(deps.session.profile()) });
    });

    app.get("/api/profile/processes", async (_req, res) => {
        try {
            const processes = await deps.session.fridaClient.listProcesses();
            res.json({ processes });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/attach", async (req, res) => {
        const { pid } = req.body ?? {};
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
            res.status(400).json({ error: "pid (positive integer) required" });
            return;
        }
        try {
            const profile = await deps.session.attach(pid);
            res.json({ profile: serializeProfile(profile) });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });

    app.post("/api/profile/detach", async (_req, res) => {
        try {
            await deps.session.detach();
            res.json({ ok: true });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
}
