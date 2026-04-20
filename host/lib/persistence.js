/* Disk persistence — bookmarks CRUD (M3). Dump persistence added in M5. */
const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "..", "..", ".toolkit-data");
const BOOK_DIR = path.join(DATA_DIR, "bookmarks");

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

module.exports = { listBookmarks, getBookmark, saveBookmark, deleteBookmark, saveDump, slugify };
