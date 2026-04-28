#!/usr/bin/env node
/* =============================================================================
 * Dofus app — local HTTP + WebSocket host (port 3001)
 * =============================================================================
 * Shares the toolkit's Frida bridge (loads the same build/rpc-agent.js).
 * Runs as its own node process — only one Frida client can attach at a time,
 * so do not start the toolkit's `npm run host` simultaneously.
 *
 * Run:   npm run host:dofus
 * Open:  http://localhost:3001
 * =============================================================================
 */

const http = require("http");
const fs   = require("fs");
const path = require("path");

const bridge      = require("../host/lib/frida-bridge");
const wsModule    = require("../host/lib/ws");
const { makeHandler, sendJson, readBody } = require("../host/lib/router");
const persistence = require("./lib/persistence");
const { broadcast } = wsModule;

const PORT       = parseInt(process.env.PORT || "3001", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

// -------- wire bridge events ------------------------------------------------
bridge.on("attached", (info) => broadcast({ type: "attached", ...info }));
bridge.on("detached", (e) => broadcast({ type: "detached", reason: e.reason }));
bridge.on("message", (m, data) => {
    try {
        const p = m && m.payload;
        if (p && p.type === "full-capture" && p.cls && p.tree) {
            const saved = persistence.saveCapture(p.cls, { cls: p.cls, ts: p.ts, tree: p.tree });
            console.log(`[dofus] persisted full-capture for ${p.cls} → ${saved.file} (${saved.bytes} bytes)`);
        } else if (p && p.type === "catalog-dump" && p.name && Array.isArray(p.items)) {
            const saved = persistence.saveCatalog(p.name, p.items);
            console.log(`[dofus] persisted catalog '${p.name}' (${saved.count} entries, ${saved.bytes} bytes)`);
        } else if (p && p.type === "map-cache" && p.mapId && p.data) {
            const saved = persistence.saveMapData(p.mapId, p.data);
            console.log(`[dofus] cached map ${p.mapId} → ${saved.file} (${saved.bytes} bytes)`);
        } else if (p && p.type === "cartography-tile" && typeof p.worldMapId === "number" && data) {
            const saved = persistence.saveCartographyTile(p.worldMapId, p.tileIndex, Buffer.from(data), p.format || "jpg");
            if (p.tileIndex === 0 || p.tileIndex % 20 === 0) {
                console.log(`[dofus] cartography wm=${p.worldMapId} tile ${p.tileIndex} → ${saved.file} (${saved.bytes} bytes)`);
            }
        } else if (p && p.type === "map-screenshot" && typeof p.mapId === "number" && data) {
            const saved = persistence.saveMapPreview(p.mapId, Buffer.from(data));
            console.log(`[dofus] map preview ${p.mapId} ${p.width}x${p.height} → ${saved.file} (${saved.bytes} bytes)`);
        }
    } catch (e) { console.error("[dofus] persistence failed:", e); }
    broadcast({ type: "message", message: m });
});

// -------- static file serving (own public + tile assets) --------------------
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".svg":  "image/svg+xml",
    ".jpg":  "image/jpeg",
    ".png":  "image/png",
    ".ico":  "image/x-icon",
};

function serveFile(res, file) {
    fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
        res.end(data);
    });
}

// Toolkit's `host/public/` is reused for shared shell assets (theme.css,
// fonts, dist/lib/*) so we don't have to duplicate them.
const TOOLKIT_PUBLIC = path.resolve(__dirname, "..", "host", "public");

async function serveStatic(req, res, pathname) {
    // /tiles/<file>.jpg → bundle-extracted cartography tile
    const tile = pathname.match(/^\/tiles\/(\d+_\S+\.(?:jpg|png))$/i);
    if (tile) {
        return serveFile(res, persistence.bundleTilePath(tile[1]));
    }
    // /icons/<category>/<id>.png → extracted Picto sprite (items, monsters, spells)
    const icon = pathname.match(/^\/icons\/([a-z]+)\/(\d+)\.png$/i);
    if (icon) {
        return serveFile(res, persistence.iconPath(icon[1], icon[2]));
    }
    // /map-preview/<mapId>.png → per-map preview (v2 cardinal-cross-fade if
    // present, else v1 single-map render). See persistence.mapPreviewPath.
    const preview = pathname.match(/^\/map-preview\/(\d+)\.png$/);
    if (preview) {
        return serveFile(res, persistence.mapPreviewPath(preview[1]));
    }
    // /map-preview-single/<id>.png → v1-first (clean single-map render with no
    // cross-fade bleed from neighbors) — used by the side panel cell overlay.
    const previewSingle = pathname.match(/^\/map-preview-single\/(\d+)\.png$/);
    if (previewSingle) {
        return serveFile(res, persistence.mapPreviewPathSingle(previewSingle[1]));
    }
    // /maps-preview/<id>.png → v1 direct (legacy single-map render, variable size).
    const previewV1 = pathname.match(/^\/maps-preview\/(\d+)\.png$/);
    if (previewV1) {
        return serveFile(res, path.join(persistence.DATA_DIR, "maps-preview", `${previewV1[1]}.png`));
    }
    // /maps-preview-v2/<id>.png → v2 direct (cross-fade slot 1204×860).
    const previewV2 = pathname.match(/^\/maps-preview-v2\/(\d+)\.png$/);
    if (previewV2) {
        return serveFile(res, path.join(persistence.DATA_DIR, "maps-preview-v2", `${previewV2[1]}.png`));
    }
    // /cell-offsets.json → per-map cell-overlay offsets (built offline by
    // build-cell-offsets.py from interactive sprite pivots).
    if (pathname === "/cell-offsets.json") {
        return serveFile(res, path.join(persistence.DATA_DIR, "cell-offsets.json"));
    }
    // /api/coverage-plan → ordered list of maps to visit for runtime capture.
    // Built offline by build-coverage-plan.py — picks maps that maximize
    // gfxId/cluster coverage, prioritizing caves with unmapped variants.
    if (pathname === "/api/coverage-plan") {
        // Optional ?file=NAME selects a specific coverage-plan-*.json variant.
        // Whitelist enforces that the file lives in DATA_DIR + matches the prefix.
        const url = new URL(req.url, "http://x");
        const variant = url.searchParams.get("file");
        let target = "coverage-plan.json";
        if (variant && /^[a-zA-Z0-9_.-]+$/.test(variant) && variant.endsWith(".json") && variant.startsWith("coverage-plan")) {
            target = variant;
        }
        return serveFile(res, path.join(persistence.DATA_DIR, target));
    }
    // /api/resource-plan → gfx-centric plan (one entry per unmapped gfxId,
    // multiple candidate maps per entry). Built by build-resource-plan.py.
    if (pathname === "/api/resource-plan") {
        return serveFile(res, path.join(persistence.DATA_DIR, "resource-plan.json"));
    }
    // /api/map-neighbors → for every cached per-map JSON, dump its `n`
    // field (4-direction physical neighbors). Used by the worldmap overlay
    // to find the connected component of a cave/dungeon by walking the
    // in-game adjacency, which is more reliable than the worldgraph
    // (worldgraph contains zone vertices and one-way edges; `n` is the
    // straight in-game N/S/E/W mapId list).
    if (pathname === "/api/map-neighbors") {
        const mapsDir = path.join(persistence.DATA_DIR, "maps");
        const out = {};
        try {
            for (const f of fs.readdirSync(mapsDir)) {
                if (!f.endsWith(".json")) continue;
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(mapsDir, f), "utf8"));
                    if (!d.mapId || !Array.isArray(d.n)) continue;
                    out[d.mapId] = d.n;
                } catch {}
            }
        } catch {}
        return sendJson(res, 200, { count: Object.keys(out).length, neighbors: out });
    }
    // /api/captured-gfx → union of all gfxIds present on data/maps/<id>.json
    // entries that have an `updatedAt` set (= captured runtime, even if
    // gfx-to-type.json wasn't rebuilt yet). Lets the coverage panel pick up
    // mid-session captures across page reloads without re-running the python
    // plan generator.
    if (pathname === "/api/captured-gfx") {
        const mapsDir = path.join(persistence.DATA_DIR, "maps");
        const set = new Set();
        let scanned = 0;
        try {
            for (const f of fs.readdirSync(mapsDir)) {
                if (!f.endsWith(".json")) continue;
                try {
                    const d = JSON.parse(fs.readFileSync(path.join(mapsDir, f), "utf8"));
                    if (!d.updatedAt) continue;
                    scanned++;
                    if (Array.isArray(d.ie)) for (const row of d.ie) if (Array.isArray(row) && row.length >= 3) set.add(Number(row[2]));
                } catch {}
            }
        } catch {}
        return sendJson(res, 200, { count: set.size, scannedMaps: scanned, gfxIds: Array.from(set) });
    }
    // /api/worldgraph → cached worldgraph adjacency for the reachability
    // checker. GET = serve cached file (404 if missing). POST = re-dump via
    // Frida + save. Worldgraph is loaded once per Dofus session at login
    // and stays static, so the disk cache is valid until the next patch.
    if (pathname === "/api/worldgraph") {
        const wgPath = path.join(persistence.DATA_DIR, "worldgraph-adjacency.json");
        if (req.method === "POST") {
            (async () => {
                try {
                    const r = await bridge.callRpc("dumpOutgoingEdges", []);
                    if (!r?.ok) return sendJson(res, 500, { error: r?.reason ?? "dump failed" });
                    fs.writeFileSync(wgPath, JSON.stringify(r));
                    return sendJson(res, 200, { ok: true, vertexCount: r.vertexCount, edgeCount: r.edgeCount, savedTo: "worldgraph-adjacency.json" });
                } catch (e) {
                    return sendJson(res, 500, { error: String(e).slice(0, 200) });
                }
            })();
            return;
        }
        // GET — serve from disk
        return serveFile(res, wgPath);
    }
    // /canonical-coords-wm{N}.json → content-based (posX,posY)→mapId map.
    // Built by build-canonical-by-content.py (CLI). The world panel uses
    // it to dedup multi-map coords to the most outdoor-looking variant.
    const cano = pathname.match(/^\/canonical-coords-wm(-?\d+)\.json$/);
    if (cano) {
        const p = path.join(persistence.DATA_DIR, `canonical-coords-wm${cano[1]}.json`);
        return serveFile(res, p);
    }

    const rel = pathname === "/" ? "/index.html" : pathname;
    // Try dofus-app/public first, fall back to toolkit public for shared
    // assets (theme.css, lib/, dist/lib/, fonts/).
    const own = path.join(PUBLIC_DIR, rel);
    if (own.startsWith(PUBLIC_DIR) && fs.existsSync(own)) return serveFile(res, own);
    const fallback = path.join(TOOLKIT_PUBLIC, rel);
    if (fallback.startsWith(TOOLKIT_PUBLIC) && fs.existsSync(fallback)) return serveFile(res, fallback);
    res.writeHead(404); res.end("not found");
}

// -------- route table -------------------------------------------------------
const routes = {
    GET: {
        "/api/processes":    async (req, res, q) => sendJson(res, 200, await bridge.listProcesses(q.q)),
        "/api/status":       (req, res)          => sendJson(res, 200, { attached: !!bridge.getAttachedInfo(), info: bridge.getAttachedInfo() }),
        "/api/maps":         (_req, res)         => sendJson(res, 200, persistence.listCachedMaps()),
        "/api/catalog":      (_req, res)         => sendJson(res, 200, persistence.listCatalogs()),
        "/api/map-previews": (_req, res)         => sendJson(res, 200, persistence.listMapPreviews()),
        "/api/resources":    (_req, res)         => sendJson(res, 200, persistence.readResources() || { items: [] }),
        "/api/tile-mapping": (_req, res) => {
            const m = persistence.readTileMapping();
            sendJson(res, 200, m || null);
        },
    },
    GET_param: {
        "/api/maps": (_req, res, _q, mapId) => {
            const m = persistence.readMapData(mapId);
            if (!m) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, m);
        },
        "/api/catalog": (_req, res, _q, slug) => {
            const c = persistence.readCatalog(slug);
            if (!c) { res.writeHead(404); res.end(); return; }
            sendJson(res, 200, c);
        },
        "/api/resource-maps": (_req, res, _q, typeId) => {
            const m = persistence.readResourceMaps();
            const ids = m && m[typeId] ? m[typeId] : [];
            sendJson(res, 200, ids);
        },
    },
    POST_param: {
        // captureCurrent() in the world-panel coverage-plan orchestrator hits
        // this. Body: { interactives: [{elementId, cell, typeId, name}, ...] }
        // saveMapData merges with existing static fields (n/a/c/ie) — only
        // overlays the runtime-resolved interactives + updatedAt.
        "/api/maps": async (req, res, _q, mapId) => {
            const body = JSON.parse(await readBody(req));
            const saved = persistence.saveMapData(mapId, body);
            sendJson(res, 200, { ok: true, ...saved });
        },
    },
    POST: {
        "/api/attach": async (req, res) => {
            const { pid } = JSON.parse(await readBody(req));
            sendJson(res, 200, await bridge.attach(pid));
        },
        "/api/detach": async (req, res) => { await bridge.detach(); sendJson(res, 200, { ok: true }); },
        "/api/reload": async (req, res) => {
            const info = bridge.getAttachedInfo();
            if (!info) throw new Error("not attached");
            sendJson(res, 200, await bridge.attach(info.pid));
        },
        "/api/call": async (req, res) => {
            const { method, args } = JSON.parse(await readBody(req));
            const result = await bridge.callRpc(method, args || []);
            sendJson(res, 200, { result });
        },
    },
};

const fallback = (req, res, pathname) => serveStatic(req, res, pathname);

// -------- server boot -------------------------------------------------------
const server = http.createServer(makeHandler(routes, fallback));
wsModule.attach(server, () => ({ type: "hello", attached: bridge.getAttachedInfo() }));

server.listen(PORT, () => {
    console.log(`[dofus] Dofus app UI → http://localhost:${PORT}`);
    const AGENT_PATH = path.resolve(__dirname, "..", "build", "rpc-agent.js");
    console.log(`[dofus] agent path: ${AGENT_PATH}`);
});

async function shutdown() {
    console.log("\n[dofus] shutting down…");
    try { await bridge.detach(); } catch {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
