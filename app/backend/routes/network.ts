import type { Express } from "express";
import type { Session } from "../session.js";
import { aggregate } from "../core/network/type-aggregator.js";
import { decodeTypeKey } from "../core/network/types.js";
import type { SerializerEntry } from "../core/network/types.js";

export interface NetworkDeps { session: Session; }

export function mountNetwork(app: Express, deps: NetworkDeps): void {
    const fs = () => deps.session.frameStore();
    const cfg = () => deps.session.serializerConfigStore();

    app.get("/api/network/frames", (req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        const direction = req.query.direction === "in" ? "in"
            : req.query.direction === "out" ? "out"
            : undefined;
        const filter = typeof req.query.filter === "string" ? req.query.filter : undefined;
        const sinceId = typeof req.query.sinceId === "string" ? req.query.sinceId : undefined;
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : undefined;
        res.json({ frames: store.list({ direction, filter, sinceId, limit }) });
    });

    app.get("/api/network/types", (_req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ types: aggregate(store.list()) });
    });

    app.get("/api/network/types/:typeKey/instances", (req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        const decoded = decodeTypeKey(req.params.typeKey);
        const limit = typeof req.query.limit === "string" ? parseInt(req.query.limit, 10) : 50;
        const all = store.byType(decoded, limit);
        const summary = aggregate(all)[0];
        res.json({ type: summary, frames: all });
    });

    app.delete("/api/network/frames", (_req, res) => {
        const store = fs();
        if (!store) { res.status(503).json({ error: "not attached" }); return; }
        store.clear();
        res.json({ ok: true });
    });

    app.get("/api/network/serializer-config", (_req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        res.json({ config: c.get() });
    });

    app.put("/api/network/serializer-config", (req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        const entries = req.body?.entries;
        if (!Array.isArray(entries)) { res.status(400).json({ error: "entries must be an array" }); return; }
        c.replace(entries as SerializerEntry[]);
        res.json({ ok: true });
    });

    app.post("/api/network/start", async (_req, res) => {
        const c = cfg();
        if (!c) { res.status(503).json({ error: "not attached" }); return; }
        const config = c.get();
        const enabled = config.entries.filter((e: SerializerEntry) => !e.disabled);
        if (enabled.length === 0) { res.status(400).json({ error: "no enabled entries" }); return; }
        try {
            const r = await deps.session.fridaClient.call<{ installed: number; failed: SerializerEntry[] }>(
                "armNetworkCapture", [config],
            );
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    app.post("/api/network/stop", async (_req, res) => {
        try {
            const r = await deps.session.fridaClient.call<{ reverted: number }>("disarmNetworkCapture");
            res.json(r);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
