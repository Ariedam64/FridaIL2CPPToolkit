/* Disk persistence — bookmarks CRUD (M3). Dump persistence added in M5. */
const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.resolve(__dirname, "..", "..", ".toolkit-data");
const BOOK_DIR   = path.join(DATA_DIR, "bookmarks");
const PRESET_DIR = path.join(DATA_DIR, "presets");
const CAPTURE_DIR = path.join(DATA_DIR, "captures");
const CATALOG_DIR = path.join(DATA_DIR, "catalog");
const MAPS_DIR    = path.join(DATA_DIR, "maps");
const CARTO_DIR   = path.join(DATA_DIR, "cartography");

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function slugify(name) {
    return String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "unnamed";
}

function listBookmarks() {
    ensureDir(BOOK_DIR);
    const files = fs.readdirSync(BOOK_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(BOOK_DIR, f), "utf8"));
            return {
                slug: f.replace(/\.json$/, ""),
                name: data.name ?? f,
                processName: data.processName ?? "",
                updatedAt: data.updatedAt ?? null,
            };
        } catch { return null; }
    }).filter(Boolean);
}

function getBookmark(slug) {
    const file = path.join(BOOK_DIR, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveBookmark(name, data) {
    ensureDir(BOOK_DIR);
    const slug = slugify(name);
    const file = path.join(BOOK_DIR, `${slug}.json`);
    const body = { ...data, name, slug, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
    return body;
}

function deleteBookmark(slug) {
    const file = path.join(BOOK_DIR, `${slug}.json`);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
}

function saveDump(content, meta = {}) {
    ensureDir(path.join(DATA_DIR, "dumps"));
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const name = (meta.name || "dump").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
    const ext = (meta.ext || "md").replace(/[^a-z]/gi, "") || "md";
    const file = path.join(DATA_DIR, "dumps", `${ts}-${name}.${ext}`);
    fs.writeFileSync(file, content, "utf8");
    return { path: file, size: Buffer.byteLength(content, "utf8"), name };
}

// -------- Presets (game-specific protocol maps, socket aliases, etc.) --------
// Each preset is JSON at .toolkit-data/presets/<slug>.json with at least:
//   { processName: "Dofus.exe", protocolMap: { clsName: { readable, direction, fields } } }

function listPresets() {
    ensureDir(PRESET_DIR);
    return fs.readdirSync(PRESET_DIR)
        .filter(f => f.endsWith(".json"))
        .map(f => {
            try {
                const data = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, f), "utf8"));
                return {
                    slug: f.replace(/\.json$/, ""),
                    processName: data.processName ?? "",
                    protocolMapSize: Object.keys(data.protocolMap ?? {}).length,
                };
            } catch { return null; }
        })
        .filter(Boolean);
}

function getPreset(slug) {
    const file = path.join(PRESET_DIR, `${slug}.json`);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Find the preset whose processName matches the attached process (exact match).
 * Returns the preset object or null.
 */
function getPresetForProcess(processName) {
    if (!processName) return null;
    for (const { slug } of listPresets()) {
        const preset = getPreset(slug);
        if (preset && preset.processName === processName) return preset;
    }
    return null;
}

function savePreset(slug, data) {
    ensureDir(PRESET_DIR);
    const cleanSlug = slugify(slug);
    const file = path.join(PRESET_DIR, `${cleanSlug}.json`);
    const body = { ...data, slug: cleanSlug, updatedAt: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf8");
    return body;
}

function saveCapture(cls, payload) {
    ensureDir(CAPTURE_DIR);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(CAPTURE_DIR, `${slugify(cls)}-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return { file: path.relative(DATA_DIR, file), bytes: fs.statSync(file).size };
}

// -------- Catalog (session-stable game data) --------
// One file per catalog at .toolkit-data/catalog/<name>.json — overwritten
// on each extraction (single latest source of truth).

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

// -------- Per-map cache (progressive, grows as player visits maps) --------

function saveMapData(mapId, data) {
    ensureDir(MAPS_DIR);
    const file = path.join(MAPS_DIR, `${mapId}.json`);
    const body = { mapId, updatedAt: new Date().toISOString(), ...data };
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

// -------- Cartography tile PNGs (binary) --------

function saveCartographyTile(worldMapId, tileIndex, buffer, ext = "jpg") {
    const dir = path.join(CARTO_DIR, `wm${worldMapId}`);
    ensureDir(dir);
    const file = path.join(dir, `tile_${String(tileIndex).padStart(3, "0")}.${ext}`);
    fs.writeFileSync(file, buffer);
    return { file: path.relative(DATA_DIR, file), bytes: buffer.length };
}

function listCartographyWorldmaps() {
    if (!fs.existsSync(CARTO_DIR)) return [];
    return fs.readdirSync(CARTO_DIR)
        .filter(d => d.startsWith("wm"))
        .map(d => {
            const id = parseInt(d.slice(2), 10);
            if (!Number.isFinite(id)) return null;
            const dir = path.join(CARTO_DIR, d);
            const tiles = fs.readdirSync(dir).filter(f => f.endsWith(".png")).length;
            return { worldMapId: id, tileCount: tiles };
        }).filter(Boolean);
}

module.exports = {
    listBookmarks, getBookmark, saveBookmark, deleteBookmark,
    saveDump, slugify,
    listPresets, getPreset, getPresetForProcess, savePreset,
    saveCapture,
    saveCatalog, readCatalog, listCatalogs,
    saveMapData, readMapData, listCachedMaps,
    saveCartographyTile, listCartographyWorldmaps,
};
