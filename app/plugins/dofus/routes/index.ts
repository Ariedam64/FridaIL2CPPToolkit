import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Express } from "express";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";
import { DofusDataStore } from "../lib/data-store";

const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface DofusMountOpts {
    /** Override default data dir for testing. Production: omitted → uses bundled data. */
    dataDir?: string;
}

export function mount(app: Express, deps: PluginBackendDeps, opts: DofusMountOpts = {}): void {
    const dataDir = opts.dataDir ?? path.resolve(_MODULE_DIR, "../data");
    const store = new DofusDataStore(dataDir);

    /** v1.5 plugin-system route, kept unchanged. */
    app.get("/api/dofus/map/current", async (_req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "not attached" }); return; }
        const player = reg.list().find((c) => c.className === "PlayerManager" && c.isAlive);
        if (!player) {
            res.status(404).json({ error: "PlayerManager not captured yet (open the Instances plugin to capture it)" });
            return;
        }
        try {
            const mapId = await deps.session.fridaClient.call(
                "readField",
                [player.className, player.handle, "currentMapId"],
            );
            res.json({ mapId });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** v1 map feature routes. */
    app.get("/api/dofus/worlds", (_req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        res.json({ worlds: store.listWorlds() });
    });

    app.get("/api/dofus/maps/list", (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const worldRaw = req.query.world;
        if (typeof worldRaw !== "string") {
            res.status(400).json({ error: "missing or invalid 'world' query param" });
            return;
        }
        const worldId = parseInt(worldRaw, 10);
        if (!Number.isFinite(worldId)) {
            res.status(400).json({ error: `'world' must be an integer, got '${worldRaw}'` });
            return;
        }
        if (!store.knowsWorld(worldId)) {
            res.status(404).json({ error: `unknown world: ${worldId}` });
            return;
        }
        res.json({ world: worldId, maps: store.listMapsByWorld(worldId) });
    });

    app.get("/api/dofus/maps/:mapId", async (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const mapId = parseInt(req.params.mapId, 10);
        if (!Number.isFinite(mapId)) {
            res.status(400).json({ error: `':mapId' must be an integer, got '${req.params.mapId}'` });
            return;
        }
        const detail = await store.loadMapDetail(mapId);
        if (!detail) { res.status(404).json({ error: `map not found: ${mapId}` }); return; }
        res.json(detail);
    });

    /** Serve a cartography tile JPG. Strict regex on filename (path-traversal safe). */
    app.get("/api/dofus/cartography/tile/:filename", (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const filename = req.params.filename;
        if (!/^\d{6}_\d+\.jpg$/.test(filename)) {
            res.status(400).json({ error: "invalid filename format" });
            return;
        }
        const full = path.join(dataDir, "cartography", "tiles", filename);
        res.sendFile(full, (err) => {
            if (err && !res.headersSent) {
                res.status(404).json({ error: `tile not found: ${filename}` });
            }
        });
    });
}
