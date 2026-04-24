/* Dofus-app persistence — per-map cells/interactives, cartography tiles,
 * runtime captures, gfxId registry, coverage plan. */
const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.resolve(__dirname, "..", "data");
const MAPS_DIR    = path.join(DATA_DIR, "maps");
const CARTO_DIR   = path.join(DATA_DIR, "cartography");
const CAPTURE_DIR = path.join(DATA_DIR, "captures");
const CATALOG_DIR = path.join(DATA_DIR, "catalog");
const WMNAMES_DIR = path.join(DATA_DIR, "wm-tile-names");
const COVERAGE_PLAN   = path.join(DATA_DIR, "coverage-plan.json");
const GFX_REGISTRY    = path.join(DATA_DIR, "gfx-to-type.json");
const TILE_MAPPING    = path.join(DATA_DIR, "tile-mapping.json");
const ADDRESSABLES    = path.join(DATA_DIR, "worldmap-addressables.json");

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function slugify(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "unnamed";
}

// -------- Per-map cache (static bundle data + runtime captures merged) -----
// Static fields (n, a, ie, c) come from extract-mapdata-bundles.py and must
// not be clobbered by a runtime CAPTURE HERE that only sends `interactives`.

function saveMapData(mapId, data) {
    ensureDir(MAPS_DIR);
    const file = path.join(MAPS_DIR, `${mapId}.json`);
    let existing = {};
    try { if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const body = { ...existing, mapId, updatedAt: new Date().toISOString(), ...data };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return { file: path.relative(DATA_DIR, file), bytes: fs.statSync(file).size };
}

function readMapData(mapId) {
    const file = path.join(MAPS_DIR, `${mapId}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listCachedMaps() {
    if (!fs.existsSync(MAPS_DIR)) return [];
    return fs.readdirSync(MAPS_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => parseInt(f.replace(/\.json$/, ""), 10))
        .filter(Number.isFinite);
}

// -------- Cartography tile binaries ----------------------------------------

function saveCartographyTile(worldMapId, tileIndex, buffer, ext = "jpg") {
    const dir = path.join(CARTO_DIR, `wm${worldMapId}`);
    ensureDir(dir);
    const file = path.join(dir, `tile_${String(tileIndex).padStart(3, "0")}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file: path.relative(DATA_DIR, file), bytes: buffer.length };
}

// -------- Catalogs (extractAllCatalogs output) -----------------------------

function saveCatalog(name, items) {
    ensureDir(CATALOG_DIR);
    const slug = slugify(name);
    const file = path.join(CATALOG_DIR, `${slug}.json`);
    const body = { name, count: Array.isArray(items) ? items.length : 0, updatedAt: new Date().toISOString(), items };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return { file: path.relative(DATA_DIR, file), bytes: fs.statSync(file).size, count: body.count };
}

function readCatalog(name) {
    const file = path.join(CATALOG_DIR, `${slugify(name)}.json`);
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function listCatalogs() {
    if (!fs.existsSync(CATALOG_DIR)) return [];
    return fs.readdirSync(CATALOG_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), "utf8"));
                return { slug: f.replace(/\.json$/, ""), name: data.name ?? f, count: data.count ?? 0, updatedAt: data.updatedAt ?? null };
            } catch { return null; }
        }).filter(Boolean);
}

// -------- Generic IL2CPP captures (full-capture) ---------------------------

function saveCapture(cls, payload) {
    ensureDir(CAPTURE_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(CAPTURE_DIR, `${slugify(cls)}-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return { file: path.relative(DATA_DIR, file), bytes: fs.statSync(file).size };
}

// -------- Static reads -----------------------------------------------------

function readCoveragePlan() {
    if (!fs.existsSync(COVERAGE_PLAN)) return null;
    try { return JSON.parse(fs.readFileSync(COVERAGE_PLAN, "utf8")); } catch { return null; }
}

function readGfxRegistry() {
    if (!fs.existsSync(GFX_REGISTRY)) return {};
    try { return JSON.parse(fs.readFileSync(GFX_REGISTRY, "utf8")); } catch { return {}; }
}

// -------- Worldmap tile-name dumps (per-wm) --------------------------------
// `listCartographyTileNames` returns {worldmaps:[{worldMapId, tiles:[{index,name,width,height}]}]}.
// We persist one snapshot per worldMapId visited so the offline matcher can
// cross-reference against the bundle/manifest.json.

function saveWmTileNames(wmId, tiles) {
    ensureDir(WMNAMES_DIR);
    const file = path.join(WMNAMES_DIR, `wm${wmId}.json`);
    const body = { worldMapId: wmId, tiles, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(body), "utf8");
    return { file: path.relative(DATA_DIR, file), bytes: fs.statSync(file).size, count: tiles.length };
}

function listWmTileNames() {
    if (!fs.existsSync(WMNAMES_DIR)) return [];
    return fs.readdirSync(WMNAMES_DIR)
        .filter(f => /^wm\d+\.json$/.test(f))
        .map(f => parseInt(f.match(/^wm(\d+)/)[1], 10));
}

// -------- Bundle-extracted cartography tiles (offline) ---------------------
// extract-worldmap-bundle.py writes 1020 tiles to data/cartography/tiles/
// with manifest.json listing {order, name, width, height, file}. The matcher
// builds tile-mapping.json which the world panel reads to render backgrounds.

function readBundleManifest() {
    const file = path.join(CARTO_DIR, "manifest.json");
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function bundleTilePath(filename) {
    return path.join(CARTO_DIR, "tiles", filename);
}

function readTileMapping() {
    if (!fs.existsSync(TILE_MAPPING)) return null;
    try { return JSON.parse(fs.readFileSync(TILE_MAPPING, "utf8")); } catch { return null; }
}

function saveAddressables(dump) {
    fs.writeFileSync(ADDRESSABLES, JSON.stringify(dump, null, 2), "utf8");
    return { file: path.relative(DATA_DIR, ADDRESSABLES), bytes: fs.statSync(ADDRESSABLES).size };
}

function readAddressables() {
    if (!fs.existsSync(ADDRESSABLES)) return null;
    try { return JSON.parse(fs.readFileSync(ADDRESSABLES, "utf8")); } catch { return null; }
}

module.exports = {
    DATA_DIR, MAPS_DIR, CARTO_DIR,
    saveMapData, readMapData, listCachedMaps,
    saveCartographyTile,
    saveCapture,
    saveCatalog, readCatalog, listCatalogs,
    readCoveragePlan, readGfxRegistry,
    saveWmTileNames, listWmTileNames,
    readBundleManifest, bundleTilePath, readTileMapping,
    saveAddressables, readAddressables,
};
