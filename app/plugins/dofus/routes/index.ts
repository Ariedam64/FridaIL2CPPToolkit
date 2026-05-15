import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { Express } from "express";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";
import { DofusDataStore } from "../lib/stores/data";
import { CraftRankingStore } from "../lib/stores/craft";
import { TradeCenterActions } from "../lib/trade/trade-center";
import { InteractiveActions } from "../lib/interactives/interactive";
import { MovementActions } from "../lib/movement/movement";
import { ChangeMapActions } from "../lib/movement/change-map";
import { MapInteractivesStore } from "../lib/stores/map-interactives";
import { isGhostInteractive } from "../lib/stores/ghost-filter";
import { LabelStore } from "../../../backend/core/labels";
import { PlayerStore } from "../lib/stores/player";
import { MapStateStore } from "../lib/stores/map-state";
import { WORLD_PATHFINDING_PROTO } from "../lib/protocol/schema";
import { resolveProto } from "../lib/protocol/resolver";
import { TravelOrchestrator } from "../lib/movement/autopilot";
import { computeWorldPath } from "../lib/movement/world-path";

const _MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export interface DofusMountOpts {
    /** Override default data dir for testing. Production: omitted → uses bundled data. */
    dataDir?: string;
    /** Override default icons dir (where <iconId>.png files live). */
    iconsDir?: string;
    /** Override default jobs static dump path. */
    jobsFilePath?: string;
}

export function mount(app: Express, deps: PluginBackendDeps, opts: DofusMountOpts = {}): void {
    const dataDir = opts.dataDir ?? path.resolve(_MODULE_DIR, "../data");
    const store = new DofusDataStore(dataDir);

    // All static data files live inside the plugin's `data/` folder so the
    // plugin is self-contained and redistributable. Callers may still override
    // any path via opts for tests.
    const iconsDir = opts.iconsDir
        ?? path.resolve(_MODULE_DIR, "../data/icons/items");
    const jobsFilePath = opts.jobsFilePath
        ?? path.resolve(_MODULE_DIR, "../data/jobs-data-root.json");
    const craftStore = new CraftRankingStore(jobsFilePath);

    // Runtime DB of map interactives — listens to the network monitor's
    // FrameStore, parses every itx, indexes per-mapId interactives + a
    // gfxId → typeId registry. Persists to .toolkit-data/maps-runtime.json
    // (runtime mutable state, separate from the read-only plugin data).
    const TOOLKIT_DATA = path.resolve(_MODULE_DIR, "../../../../.toolkit-data");
    // The store needs a LabelStore so it can re-resolve obfuscated itx/kne/knc
    // names on the fly. We can't take it at mount time (no profile yet), so
    // we plumb it through a getter that's evaluated lazily — and rebuild the
    // store whenever the active profile changes.
    // The store is created EAGERLY at mount so the disk-loaded data is
    // browseable without an attached profile. When no profile is active, we
    // use a stub LabelStore (points at a non-existent file → loads empty,
    // returns null on every resolve, never emits change events). The store
    // gracefully falls back to obfuscated-name defaults via DEFAULT_ITX_OBF.
    let mapInteractives: MapInteractivesStore;
    function makeMapInteractivesStore(): MapInteractivesStore {
        const profile = deps.session.profile();
        // Stub LabelStore: path points at a non-existent file in the plugin's
        // data folder so LabelStore loads empty + every resolve returns null.
        // We don't actually need the file to exist — it's a "no labels" sentinel.
        const stubLabelsPath = path.resolve(_MODULE_DIR, "../data/.stub-labels.json");
        const labels = profile?.labels ?? new LabelStore(stubLabelsPath);
        return new MapInteractivesStore({
            filePath: path.join(TOOLKIT_DATA, "maps-runtime.json"),
            staticDbPath: path.resolve(_MODULE_DIR, "../data/static-db.json"),
            dataStore: store,
            labels,
        });
    }
    let detachInteractives: (() => void) | null = null;
    function rewireInteractives(): void {
        if (detachInteractives) { detachInteractives(); detachInteractives = null; }
        if (mapInteractives) mapInteractives.dispose();
        mapInteractives = makeMapInteractivesStore();
        const fs = deps.session.frameStore();
        if (fs) detachInteractives = mapInteractives.attach(fs);
    }
    mapInteractives = makeMapInteractivesStore();

    // -------------------------------------------------------------------------
    // PlayerStore — live mirror of player position/move state.
    // Created on profile-attached, disposed on detached. WS-frame-driven via
    // 4 movement-related obfs (resolved through labels so it survives renames).
    // -------------------------------------------------------------------------
    let playerStore: PlayerStore | null = null;
    let mapStateStore: MapStateStore | null = null;
    let autopilot: TravelOrchestrator | null = null;
    let detachPlayerListener: (() => void) | null = null;
    let detachMapStateListener: (() => void) | null = null;

    function rewireStores(): void {
        if (autopilot) { autopilot.dispose(); autopilot = null; }
        if (detachPlayerListener)   { detachPlayerListener();   detachPlayerListener = null; }
        if (detachMapStateListener) { detachMapStateListener(); detachMapStateListener = null; }
        if (playerStore)   { playerStore.dispose();   playerStore = null; }
        if (mapStateStore) { mapStateStore.dispose(); mapStateStore = null; }
        const profile = deps.session.profile();
        if (!profile) return;

        playerStore   = new PlayerStore(deps.session, profile.labels, deps.session.fridaClient);
        mapStateStore = new MapStateStore(deps.session, profile.labels, deps.session.fridaClient);

        const movementForAutopilot = new MovementActions(profile.labels, deps.session.fridaClient, mapInteractives, store);
        autopilot = new TravelOrchestrator({
            getCurrentCell:   () => playerStore!.getState().currentCellId,
            getCurrentMapId:  () => mapStateStore!.getState().mapId,
            onMapChange:      (cb) => mapStateStore!.onChange(() => cb()),
            movement:         movementForAutopilot,
            computeWorldPath: (src, dest) => computeWorldPath(src, dest),
        });

        detachPlayerListener = playerStore.onChange((state) => {
            deps.session.emit("dofus-player-state-changed", state);
        });
        // Pipe entities through to PlayerStore ONLY on a "snapshot" emit —
        // which happens on itx parse (full map refresh). On "patch" emits
        // (ieu/iet/itv/irx/jvn) we do NOT re-derive currentCellId from
        // entities[] because PlayerStore tracks the local player's position
        // authoritatively via its own itv/itr handlers, and the patch may
        // have updated our own entity entry to the move destination — which
        // would clobber the freshly-computed currentCellId.
        detachMapStateListener = mapStateStore.onChange((state, kind) => {
            deps.session.emit("dofus-map-state-changed", state);
            if (playerStore && kind === "snapshot") playerStore.handleMapEntities(state.entities);
        });

        // Bootstrap from the runtime: PlayerStore reads dve/ghg via the agent,
        // MapStateStore reads MapRenderer.currentMapId then forges an isp so
        // the server re-broadcasts an itx (entity list lands a moment later).
        void playerStore.refresh();
        void mapStateStore.bootstrap();
    }

    deps.session.on("profile-attached", () => {
        rewireInteractives();
        rewireStores();
        void autoArmNetworkCapture();
    });
    deps.session.on("profile-detached", () => {
        if (detachInteractives) { detachInteractives(); detachInteractives = null; }
        if (detachPlayerListener)   { detachPlayerListener();   detachPlayerListener = null; }
        if (detachMapStateListener) { detachMapStateListener(); detachMapStateListener = null; }
        if (playerStore)   { playerStore.dispose();   playerStore = null; }
        if (mapStateStore) { mapStateStore.dispose(); mapStateStore = null; }
        if (autopilot) { autopilot.dispose(); autopilot = null; }
        // Recreate map interactives with a stub LabelStore so disk reads keep working.
        rewireInteractives();
    });

    /** Auto-arm the network capture on attach if the user has any enabled
     *  entries in their serializer config — saves them clicking "Start" on
     *  the network panel each session. The MapInteractivesStore can't see
     *  any itx until the capture is armed. Idempotent (skips already-installed). */
    async function autoArmNetworkCapture(): Promise<void> {
        if (!deps.session.fridaClient.isAttached()) return;
        const cfgStore = deps.session.serializerConfigStore();
        if (!cfgStore) return;
        const config = cfgStore.get();
        if (config.entries.filter((e) => !e.disabled).length === 0) return;
        try {
            await deps.session.fridaClient.call("armNetworkCapture", [config]);
            console.log("[dofus] auto-armed network capture");
        } catch (e) {
            console.warn("[dofus] auto-arm failed:", e);
        }
    }
    // Trigger once at mount — covers the case where the profile is already
    // attached when the plugin loads (warm reload, tsx watch).
    void autoArmNetworkCapture();

    /** Snapshot of the player's live state (mapId, target cell, isMoving).
     *  Read off the in-memory PlayerStore — no agent round-trip per request.
     *  The store refreshes itself on every move-related WS frame, so polling
     *  this endpoint is cheap (it's just memory).
     *  Returns null fields when the agent isn't attached yet. */
    app.get("/api/dofus/player/state", (_req, res) => {
        if (!playerStore) {
            res.json({
                currentCellId: null, targetCellId: null,
                cellPath: [], isMoving: false, characterId: null,
            });
            return;
        }
        res.json(playerStore.getState());
    });

    /** Force a re-read from the live instances. Mostly useful for the UI to
     *  recover after a `profile-detached` blip or for manual debugging — the
     *  store auto-refreshes on movement frames, so this rarely needs calling. */
    app.post("/api/dofus/player/state/refresh", async (_req, res) => {
        if (!playerStore) { res.status(503).json({ error: "not attached" }); return; }
        await playerStore.refresh();
        res.json(playerStore.getState());
    });

    /** Resolved WorldPathfinding proto, used by both cached + compute. */
    function worldPathfindingProto(profile: NonNullable<ReturnType<typeof deps.session.profile>>): unknown {
        return resolveProto(profile.labels, WORLD_PATHFINDING_PROTO);
    }

    /** Drain the agent's world-pathfinding diagnostic log. */
    app.get("/api/dofus/world-pathfinding/diag", async (_req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const result = await deps.session.fridaClient.call("getWorldPathfindingDiag", []);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** Install the deliverResult capture hook (and the bapc diag hook).
     *  Idempotent. Called by the state page on mount so any in-game
     *  auto-travel published before the user's first active invoke still
     *  ends up in the diag log. */
    app.post("/api/dofus/world-pathfinding/init", async (_req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const result = await deps.session.fridaClient.call("initWorldPathfindingHooks", [worldPathfindingProto(profile)]);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** Read the last cached world path off the WorldPathfinder instance.
     *  Pure field reads — no method invocation, no side effects on travel. */
    app.get("/api/dofus/world-pathfinding/cached", async (_req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const result = await deps.session.fridaClient.call("readCachedWorldPath", [worldPathfindingProto(profile)]);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** Compute the shortest world path from `srcMapId` (defaults to the
     *  player's current map) to `destMapId`. Runs entirely in JS over the
     *  extracted world graph cache — no `bapj` invoke, no game thread, no
     *  side effects. The first call after attach auto-extracts the graph
     *  (~9s); subsequent calls are sub-millisecond. */
    app.post("/api/dofus/world-pathfinding/compute", async (req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        const destMapId = String(req.body?.destMapId ?? "");
        if (!/^\d+$/.test(destMapId)) { res.status(400).json({ error: "destMapId (numeric string) required" }); return; }

        // Defaults — caller may override via body.srcMapId / body.currentCellId.
        const srcMapIdBody = req.body?.srcMapId;
        const srcFromStore = mapStateStore?.getState().mapId;
        const srcMapId = srcMapIdBody != null && /^\d+$/.test(String(srcMapIdBody))
            ? String(srcMapIdBody)
            : (srcFromStore != null ? String(srcFromStore) : "");
        if (!srcMapId) {
            res.status(400).json({ error: "srcMapId unknown — pass it in the body, or wait for the map store to bootstrap" });
            return;
        }

        try {
            // First call after attach: auto-extract the graph from the live
            // PathFindingData. Subsequent calls are pure JS over the cache.
            const { loadGraph, saveGraph } = await import("../lib/movement/world-path.js");
            let graph = loadGraph();
            if (!graph) {
                const result = await deps.session.fridaClient.call("extractWorldGraph", [{
                    proto: worldPathfindingProto(profile),
                }]) as any;
                if (!result?.ok) { res.status(500).json({ error: `graph extraction failed: ${result?.reason ?? "unknown"}` }); return; }
                saveGraph({
                    vertices: result.vertices,
                    outgoing: result.outgoing,
                    verticesByMap: result.verticesByMap,
                    counts: result.counts,
                });
                graph = loadGraph();
            }
            if (!graph) { res.status(500).json({ error: "graph load failed after extract" }); return; }

            const out = computeWorldPath(Number(srcMapId), Number(destMapId), graph);
            if (!out.ok) {
                res.json({ ok: false, reason: out.reason });
                return;
            }
            res.json({
                ok: true,
                fresh: true,
                edges: out.edges.map((e) => ({ from: e.from, to: e.to, transitions: e.transitions })),
                iterations: out.iterations,
                elapsedMs: out.elapsedMs,
            });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** Extract the full world graph from `ell.dkdy` (PathFindingData), save it
     *  to data/world-graph.json, and return metadata only (full payload is
     *  ~6MB). One-shot, slow (~9s); subsequent /compute calls hit the cache.
     *  Use this to re-extract after a Dofus update — the graph data is the
     *  only piece that can change between game versions. */
    app.get("/api/dofus/world-pathfinding/extract-graph", async (_req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const result = await deps.session.fridaClient.call("extractWorldGraph", [{
                proto: worldPathfindingProto(profile),
            }]) as any;
            if (result?.ok) {
                const { saveGraph } = await import("../lib/movement/world-path.js");
                saveGraph({
                    vertices: result.vertices,
                    outgoing: result.outgoing,
                    verticesByMap: result.verticesByMap,
                    counts: result.counts,
                });
            }
            res.json({ ok: result?.ok, reason: result?.reason, counts: result?.counts, elapsedMs: result?.elapsedMs });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    /** Snapshot of the current map (mapId + entity list with name/level/cell).
     *  Sourced from the latest itx the server broadcast — at attach we force
     *  an itx by forging a self-addressed `isp` so the data is available
     *  immediately, without waiting for a natural map change. */
    app.get("/api/dofus/map/state", (_req, res) => {
        if (!mapStateStore) {
            res.json({ mapId: null, entities: [], interactables: [] });
            return;
        }
        res.json(mapStateStore.getState());
    });

    /** Manually re-bootstrap the MapStateStore (read mapId + forge isp).
     *  Useful for debugging — the natural flow handles map changes already. */
    app.post("/api/dofus/map/state/refresh", async (_req, res) => {
        if (!mapStateStore) { res.status(503).json({ error: "not attached" }); return; }
        await mapStateStore.bootstrap();
        res.json(mapStateStore.getState());
    });

    /** Current mapId — read from the MapInteractivesStore which tracks the
     *  latest `itx` (sent by the server on every map change). No class
     *  lookup needed; the field is updated by the network monitor pipeline.
     *  Returns 404 if no itx has been seen yet (the player needs to step
     *  on at least one map after attaching). */
    app.get("/api/dofus/map/current", (_req, res) => {
        const mapId = mapInteractives.getCurrentMapId();
        if (mapId === null) {
            res.status(404).json({ error: "no map seen yet — change map once after attaching" });
            return;
        }
        res.json({ mapId });
    });

    /** Aggregate stats over the runtime DB. Always available — the store is
     *  loaded from disk at plugin mount, so attachment isn't required. */
    app.get("/api/dofus/stats", (_req, res) => {
        res.json(mapInteractives.getStats());
    });

    /** Static-DB summary: returns the typeIds we've resolved (gfxIds learned)
     *  vs the total catalog size. Used by the State page's DB panel to give
     *  the user a live "we know X of Y types" counter and the actual list of
     *  what's been learned. Hydrates skill names + gathered items so the
     *  frontend doesn't need a second fetch. */
    app.get("/api/dofus/static-db/summary", (_req, res) => {
        const db = mapInteractives.getStaticDbSummary();
        res.json(db);
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

    /** Runtime view of a map's interactives. Merges:
     *   - The latest itx capture for that map (if any), giving full info
     *     including current skillInstanceUids
     *   - The static `ie` triples (cell, elementId, gfxId)
     *   - The gfxId registry, used to label interactives on maps we've never
     *     visited (gfxId is in the static `ie`, the registry maps it → typeId)
     *
     * Result: every interactive present in static gets at least its cell +
     * elementId + gfxId, plus typeId/name when known, plus skill UIDs when
     * we've seen this map live in the current session. */
    app.get("/api/dofus/maps/:mapId/runtime", async (req, res) => {
        if (!store.dataReady) { res.status(503).json({ error: "static map data not loaded" }); return; }
        const mapId = parseInt(req.params.mapId, 10);
        if (!Number.isFinite(mapId)) { res.status(400).json({ error: "invalid mapId" }); return; }

        const detail = await store.loadMapDetail(mapId);
        if (!detail) { res.status(404).json({ error: `map not found: ${mapId}` }); return; }
        const runtime = mapInteractives.getMap(mapId);
        const runtimeByElementId = new Map<number, NonNullable<ReturnType<MapInteractivesStore["getMap"]>>["interactives"][number]>();
        if (runtime) {
            for (const i of runtime.interactives) runtimeByElementId.set(i.elementId, i);
        }

        // Hydrate skillIds → { skillId, skillName, gatheredItem? } via static DB.
        const hydrateSkill = (skillId: number) => {
            const e = mapInteractives.skillEntry(skillId);
            const skillName = e ? (e.gatheredItem ? `${e.name} (${e.gatheredItem.name})` : e.name) : `Skill #${skillId}`;
            const gatheredItem = e?.gatheredItem ? { itemId: e.gatheredItem.id, name: e.gatheredItem.name } : undefined;
            return { skillId, skillName, ...(gatheredItem ? { gatheredItem } : {}) };
        };

        // Drop ghost interactives — sprites visible from this map but not
        // actually interactable here. See ghost-filter.ts for the two rules
        // (transition cell + sprite-position-projects-outside-grid).
        const realStaticIe: typeof detail.interactives = [];
        const ghostElementIds = new Set<number>();
        for (const triple of detail.interactives) {
            const isGhost = isGhostInteractive(
                triple as readonly number[],
                detail.cells as ReadonlyArray<readonly [number, number, number, number, number]>,
            );
            if (isGhost) ghostElementIds.add(triple[1]);
            else realStaticIe.push(triple);
        }

        const staticElementIds = new Set(realStaticIe.map(([, eid]) => eid));
        type Out = {
            cell: number; elementId: number; gfxId: number;
            typeId: number | null; typeName: string | null;
            skills: ReturnType<typeof hydrateSkill>[];
            source: "live" | "gfx-registry" | "unknown";
        };
        const interactives: Out[] = [];

        for (const [cell, elementId, gfxId] of realStaticIe) {
            const live = runtimeByElementId.get(elementId);
            if (live) {
                interactives.push({
                    cell, elementId, gfxId,
                    typeId: live.typeId, typeName: mapInteractives.typeName(live.typeId),
                    skills: live.skillIds.map(hydrateSkill),
                    source: "live",
                });
                continue;
            }
            // Map never visited (or this element wasn't in the latest itx).
            // We can still label via the cumulative gfx → typeId we've learned.
            const reg = mapInteractives.typeForGfx(gfxId);
            interactives.push({
                cell, elementId, gfxId,
                typeId: reg?.typeId ?? null,
                typeName: reg?.typeName ?? null,
                skills: [],
                source: reg ? "gfx-registry" : "unknown",
            });
        }
        // Live entries not in static `ie` → zaaps, mode-marchand player shops, etc.
        // Skip elementIds we just filtered out as ghosts — the server still
        // echoes them in itx (cross-map shared eids) but they're unreachable
        // from this map's viewpoint.
        for (const i of runtime?.interactives ?? []) {
            if (staticElementIds.has(i.elementId)) continue;
            if (ghostElementIds.has(i.elementId)) continue;
            interactives.push({
                cell: i.cell ?? -1, elementId: i.elementId, gfxId: i.gfxId ?? 0,
                typeId: i.typeId, typeName: mapInteractives.typeName(i.typeId),
                skills: i.skillIds.map(hydrateSkill),
                source: "live",
            });
        }

        res.json({
            mapId,
            interactives,
            lastSeenAt: runtime?.lastSeenAt ?? null,
        });
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
        // Strip ghost interactives so the rendering canvas matches what's
        // actually interactable in-game. See ghost-filter.ts.
        const filtered = {
            ...detail,
            interactives: detail.interactives.filter(
                (t) => !isGhostInteractive(
                    t as readonly number[],
                    detail.cells as ReadonlyArray<readonly [number, number, number, number, number]>,
                ),
            ),
        };
        res.json(filtered);
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

    // ---- HDV / Craft profitability ----

    app.get("/api/dofus/craft/ranking", (_req, res) => {
        const snap = craftStore.snapshot();
        if (!snap) {
            res.json({ ranking: [], lastUpdate: null });
            return;
        }
        res.json(snap);
    });

    app.post("/api/dofus/craft/refresh", async (_req, res) => {
        try {
            const ranking = await craftStore.refresh(deps.session.fridaClient);
            const snap = craftStore.snapshot();
            res.json({ ranking, lastUpdate: snap?.lastUpdate ?? Date.now() });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });

    // ---- Trade Center actions (test surface) ----
    //
    // Each route resolves the protocol spec → current obf names via the
    // LabelStore, dispatches the outgoing packet via Frida, then awaits the
    // matching response on the network monitor's FrameStore.

    function tcActions(res: import("express").Response): TradeCenterActions | null {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return null; }
        const fs = deps.session.frameStore();
        if (!fs) { res.status(503).json({ error: "frame store unavailable" }); return null; }
        return new TradeCenterActions(profile.labels, deps.session.fridaClient, fs);
    }

    app.post("/api/dofus/tc/open", async (req, res) => {
        const a = tcActions(res); if (!a) return;
        const interactionId = Number(req.body?.interactionId);
        const extra = Number(req.body?.extra ?? 0);
        const waitMs = Number(req.body?.waitMs ?? 1500);
        if (!Number.isFinite(interactionId)) { res.status(400).json({ error: "interactionId required" }); return; }
        try { res.json(await a.openTradeCenter(interactionId, extra, waitMs)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    app.post("/api/dofus/tc/select", async (req, res) => {
        const a = tcActions(res); if (!a) return;
        const typeId = Number(req.body?.typeId);
        const waitMs = Number(req.body?.waitMs ?? 1500);
        if (!Number.isFinite(typeId)) { res.status(400).json({ error: "typeId required" }); return; }
        try { res.json(await a.selectCategory(typeId, waitMs)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    app.post("/api/dofus/tc/fetch", async (req, res) => {
        const a = tcActions(res); if (!a) return;
        const itemId = Number(req.body?.itemId);
        const waitMs = Number(req.body?.waitMs ?? 1500);
        if (!Number.isFinite(itemId)) { res.status(400).json({ error: "itemId required" }); return; }
        try { res.json(await a.fetchItemDetail(itemId, waitMs)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    app.post("/api/dofus/tc/buy", async (req, res) => {
        const a = tcActions(res); if (!a) return;
        const auctionId = Number(req.body?.auctionId);
        const quantity = Number(req.body?.quantity);
        const price = Number(req.body?.price);
        const waitMs = Number(req.body?.waitMs ?? 2500);
        if (![auctionId, quantity, price].every(Number.isFinite)) {
            res.status(400).json({ error: "auctionId, quantity, price required" }); return;
        }
        try { res.json(await a.buyOffer(auctionId, quantity, price, waitMs)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // ---- Movement (pathfinder + isa dispatch) ----
    //
    // Both endpoints use the static map cells (mov/nonRP flags) and BFS
    // through pathfinder.ts. /compute is a dry-run for UI previews; /move
    // also dispatches the isa frame.

    function movementActions(res: import("express").Response): MovementActions | null {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return null; }
        return new MovementActions(profile.labels, deps.session.fridaClient, mapInteractives, store);
    }

    app.post("/api/dofus/movement/compute", async (req, res) => {
        const a = movementActions(res); if (!a) return;
        const fromCell = Number(req.body?.fromCell);
        const toCell   = Number(req.body?.toCell);
        if (![fromCell, toCell].every(Number.isFinite)) {
            res.status(400).json({ error: "fromCell, toCell required" }); return;
        }
        const mapId = req.body?.mapId !== undefined ? Number(req.body.mapId) : undefined;
        try { res.json(await a.computePath(fromCell, toCell, mapId)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    app.post("/api/dofus/movement/move", async (req, res) => {
        const a = movementActions(res); if (!a) return;
        const fromCell = Number(req.body?.fromCell);
        const toCell   = Number(req.body?.toCell);
        if (![fromCell, toCell].every(Number.isFinite)) {
            res.status(400).json({ error: "fromCell, toCell required" }); return;
        }
        const mapId = req.body?.mapId !== undefined ? Number(req.body.mapId) : undefined;
        try { res.json(await a.moveTo(fromCell, toCell, mapId)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // ---- Map change ----
    //
    // Orchestrates the 3-packet transition (ito → wait knw → jnr + isp → wait kta).
    // Caller passes the target mapId; the function returns when kta lands or
    // a timeout fires. The server validates the mapId — unreachable maps
    // produce a timeout on the transition ack (no knw arrives).
    app.post("/api/dofus/map/change", async (req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        const mapId = Number(req.body?.mapId);
        if (!Number.isFinite(mapId)) { res.status(400).json({ error: "mapId required" }); return; }
        const fast = req.body?.fast === true;
        const actions = new ChangeMapActions(
            profile.labels,
            deps.session.fridaClient,
            () => deps.session.frameStore(),
        );
        try { res.json(await actions.changeMap(mapId, { fast })); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    // ---- Autopilot (movement + change-map chain) ----
    //
    // Single instance per session (`autopilot` above). Endpoints are inert
    // when no profile is attached. `start` returns synchronously once
    // planning settles; the loop runs in the background. Caller polls
    // `/status` to observe progression.
    app.post("/api/dofus/travel/start", async (req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        const destMapId = Number(req.body?.destMapId);
        if (!Number.isFinite(destMapId)) {
            res.status(400).json({ error: "destMapId required" });
            return;
        }
        // Pre-check 'already running' so we can return a clean 409 (the
        // orchestrator's own guard returns 200 ok:false, which the UI would
        // misclassify as a planning failure).
        if (autopilot.getStatus().state === "running") {
            res.status(409).json({ error: "travel already running" });
            return;
        }
        // Fire-and-forget the orchestrator: the start() promise resolves
        // when the WHOLE travel ends, not when planning settles. The HTTP
        // response should only reflect planning outcome — kick start() in
        // the background, then peek getStatus() after one tick.
        const startP = autopilot.start(destMapId);
        // Yield once so synchronous-failure paths ("no path", "destMapId
        // not in graph", "already on destination") have flushed into status.
        await new Promise<void>(r => setImmediate(r));
        const s = autopilot.getStatus();
        if (s.state === "failed") {
            // Planning failure (also "no current cell/mapId" guards).
            // Surface synchronously, swallow startP (already settled).
            void startP;
            res.json({ ok: false, reason: s.lastError });
            return;
        }
        if (s.state === "done") {
            void startP;
            res.json({ ok: true, totalEdges: 0, alreadyOnMap: true });
            return;
        }
        // state === "running" — travel kicked off, loop runs in background.
        // Don't await startP (would block until the whole journey ends).
        void startP;
        res.json({ ok: true, totalEdges: s.totalEdges });
    });

    app.post("/api/dofus/travel/cancel", (_req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        res.json(autopilot.cancel());
    });

    app.get("/api/dofus/travel/status", (_req, res) => {
        if (!autopilot) { res.status(503).json({ error: "not attached" }); return; }
        res.json(autopilot.getStatus());
    });

    // ---- Interactive use (harvest, talk to NPC, use zaap, ...) ----
    //
    // Resolves the skillInstanceUid from the live MapStateStore (mirror of
    // current itx in RAM) — caller never needs to deal with the ephemeral
    // server-allocated UIDs. Defaults to the first enabled skill if `skillId`
    // is omitted.
    app.post("/api/dofus/interactive/use", async (req, res) => {
        const profile = deps.session.profile();
        if (!profile) { res.status(503).json({ error: "not attached" }); return; }
        if (!mapStateStore) { res.status(503).json({ error: "map state not initialised" }); return; }
        const elementId = Number(req.body?.elementId);
        if (!Number.isFinite(elementId)) { res.status(400).json({ error: "elementId required" }); return; }
        const skillId = req.body?.skillId !== undefined ? Number(req.body.skillId) : undefined;
        const actions = new InteractiveActions(profile.labels, deps.session.fridaClient, mapInteractives, mapStateStore);
        try { res.json(await actions.useInteractive(elementId, skillId)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });

    app.post("/api/dofus/tc/buy-now", async (req, res) => {
        const a = tcActions(res); if (!a) return;
        const itemId = Number(req.body?.itemId);
        const quantity = Number(req.body?.quantity);
        if (![itemId, quantity].every(Number.isFinite)) {
            res.status(400).json({ error: "itemId, quantity required" }); return;
        }
        const opts: { interactionId?: number; extra?: number; maxPrice?: number } = {};
        if (req.body?.interactionId !== undefined) opts.interactionId = Number(req.body.interactionId);
        if (req.body?.extra !== undefined) opts.extra = Number(req.body.extra);
        if (req.body?.maxPrice !== undefined) opts.maxPrice = Number(req.body.maxPrice);
        try { res.json(await a.buyNow(itemId, quantity, opts)); }
        catch (err) { res.status(500).json({ error: err instanceof Error ? err.message : String(err) }); }
    });


    /** Serve an item icon PNG. Strict regex on iconId (path-traversal safe). */
    app.get("/api/dofus/items/icon/:iconId.png", (req, res) => {
        const id = req.params.iconId;
        if (!/^\d+$/.test(id)) {
            res.status(400).json({ error: "iconId must be numeric" });
            return;
        }
        const full = path.join(iconsDir, `${id}.png`);
        res.sendFile(full, (err) => {
            if (err && !res.headersSent) {
                res.status(404).end();
            }
        });
    });

    /** Serve a monster icon PNG. Same shape as the item icon serve. */
    const MONSTERS_ICONS_DIR = path.resolve(_MODULE_DIR, "../data/icons/monsters");
    app.get("/api/dofus/monsters/icon/:iconId.png", (req, res) => {
        const id = req.params.iconId;
        if (!/^\d+$/.test(id)) {
            res.status(400).json({ error: "iconId must be numeric" });
            return;
        }
        const full = path.join(MONSTERS_ICONS_DIR, `${id}.png`);
        res.sendFile(full, (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    });

    /** Serve a pre-built catalog file (items / monsters / jobs / skills /
     *  itemtypes / collectables / areas / subareas / worldmaps / interactives
     *  / skillnames). The frontend caches the JSON and filters client-side. */
    const CATALOG_DIR = path.resolve(_MODULE_DIR, "../data/catalog");
    const CATALOG_WHITELIST = new Set([
        "items", "monsters", "jobs", "skills", "itemtypes", "collectables",
        "areas", "subareas", "worldmaps", "interactives", "skillnames",
    ]);
    app.get("/api/dofus/catalog/:name", (req, res) => {
        const name = req.params.name;
        if (!CATALOG_WHITELIST.has(name)) {
            res.status(404).json({ error: `unknown catalog: ${name}` });
            return;
        }
        res.sendFile(path.join(CATALOG_DIR, `${name}.json`), (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    });

    app.get("/api/dofus/tile-mapping", (req, res) => {
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
        const all = store.loadTileMapping();
        const tiles = all[String(worldId)] ?? [];
        res.json({ world: worldId, tiles });
    });
}
