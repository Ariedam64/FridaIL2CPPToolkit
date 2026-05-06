// app/backend/routes/api-call.ts
import type { Express } from "express";
import type { FridaClient } from "../frida-client.js";

export interface ApiCallDeps {
    fridaClient: FridaClient;
}

export function mountApiCall(app: Express, deps: ApiCallDeps): void {
    app.post("/api/call", async (req, res) => {
        const { method, args } = req.body ?? {};
        if (typeof method !== "string" || method.length === 0) {
            res.status(400).json({ error: "method required" });
            return;
        }
        if (!deps.fridaClient.isAttached()) {
            res.status(503).json({ error: "not attached" });
            return;
        }
        try {
            const result = await deps.fridaClient.call(method, Array.isArray(args) ? args : []);
            res.json({ result });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            res.status(500).json({ error: msg });
        }
    });
}
