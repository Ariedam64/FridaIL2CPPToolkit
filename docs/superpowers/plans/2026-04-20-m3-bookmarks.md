# M3 — Bookmarks / Presets Implementation Plan

**Goal:** Make the toolkit remember what the user has figured out for a given game. A **bookmark** is a named recipe tied to a process name, containing: active hooks, active patches, and watchlist pins. One click on "load preset" re-applies all of it. Auto-offer the matching preset when the user attaches to a process that has one.

**Architecture:**
- **Persistence**: disk-backed JSON files in `.toolkit-data/bookmarks/<slug>.json`. Implement `host/lib/persistence.js` (currently a stub).
- **REST API**: 4 endpoints — `GET /api/bookmarks`, `GET /api/bookmarks/:name`, `POST /api/bookmarks/:name`, `DELETE /api/bookmarks/:name`.
- **Client-side session tracker** (`host/public/lib/session.ts`): a module-level store of "things I applied in this session" (hooks, patches). Populated every time the user clicks hook/patch buttons. Cleared on detach. Simpler than agent-side tracking and sufficient for the UX.
- **UI**: new sidebar tab "bookmarks" with list, save-current, load, delete, export, import. Auto-offer on `attached` event.

**Scope boundary — what M3 does NOT do:**
- No bookmark versioning (overwrite on save).
- No diff between current session and bookmark (overwrite on load).
- No instance-field patches (too state-dependent — they require a capture first; M4 can revisit).
- No automatic captures on load (user still clicks capture manually; bookmarks remember hooks/patches/pins, not the capture itself).

---

## Task 1: Implement `persistence.js`

**Files:**
- Modify: `host/lib/persistence.js` (currently a stub)

Replace the 6 stub functions with real implementations. Storage at `.toolkit-data/bookmarks/<slug>.json` where `<slug>` is derived from the bookmark name (lowercase, non-alphanumeric → `-`, no leading/trailing dashes, max 40 chars). Dump files stay out-of-scope for M3 (M5 adds them).

```js
const fs = require("fs");
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

function saveDump(_payload, _meta) { throw new Error("saveDump: implemented in M5"); }

module.exports = { listBookmarks, getBookmark, saveBookmark, deleteBookmark, saveDump };
```

**Verification:** `node -e "require('./host/lib/persistence.js').listBookmarks()"` returns `[]`. Writing a test bookmark then listing finds it.

**Commit:** `feat(persistence): implement disk-backed bookmarks CRUD`

---

## Task 2: REST routes for bookmarks

**Files:**
- Modify: `host/server.js`

Wire 4 endpoints in the route table:

```js
const persistence = require("./lib/persistence");

// add to routes.GET:
"/api/bookmarks": (_req, res) => sendJson(res, 200, persistence.listBookmarks()),

// add a regex-ish routing for /api/bookmarks/:slug
```

The current router.js uses exact-match paths. To keep it simple, add a single handler for `/api/bookmarks/:slug` by matching the prefix in the fallback, OR extend the router module with a trivial param-route helper. Cleanest: add a dedicated route matcher for the 3 parameterized bookmarks routes.

**Recommended approach** — extend `router.js`:

```js
// in router.js, extend makeHandler to support a prefix-param matcher
function makeHandler(routes, fallback) {
    return async function(req, res) {
        const parsed = url.parse(req.url, true);
        try {
            // Exact match first
            const exact = routes[req.method]?.[parsed.pathname];
            if (exact) return await exact(req, res, parsed.query);
            // Parameterized match (prefix + trailing segment)
            const paramRoutes = routes[`${req.method}_param`] || {};
            for (const [prefix, handler] of Object.entries(paramRoutes)) {
                if (parsed.pathname.startsWith(prefix + "/")) {
                    const slug = parsed.pathname.slice(prefix.length + 1);
                    if (!slug.includes("/")) return await handler(req, res, parsed.query, slug);
                }
            }
            if (fallback) return await fallback(req, res, parsed.pathname);
            res.writeHead(404); res.end("not found");
        } catch (e) {
            console.error("[http]", e);
            sendJson(res, 500, { error: String(e.message || e) });
        }
    };
}
```

Then in `server.js`:
```js
const routes = {
    GET: { ..., "/api/bookmarks": (_req, res) => sendJson(res, 200, persistence.listBookmarks()) },
    GET_param:    { "/api/bookmarks": (_req, res, _q, slug) => {
        const bm = persistence.getBookmark(slug);
        if (!bm) { res.writeHead(404); res.end(); return; }
        sendJson(res, 200, bm);
    }},
    POST: { ... },
    POST_param:   { "/api/bookmarks": async (req, res, _q, slug) => {
        const body = JSON.parse(await readBody(req));
        sendJson(res, 200, persistence.saveBookmark(body.name || slug, body));
    }},
    DELETE_param: { "/api/bookmarks": (_req, res, _q, slug) => {
        sendJson(res, 200, { deleted: persistence.deleteBookmark(slug) });
    }},
};
```

**Verification:**
- `curl http://localhost:3000/api/bookmarks` returns `[]`
- `curl -X POST -H 'Content-Type: application/json' -d '{"name":"test","pins":[]}' http://localhost:3000/api/bookmarks/test` returns the saved body
- `curl http://localhost:3000/api/bookmarks/test` returns the body
- `curl -X DELETE http://localhost:3000/api/bookmarks/test` returns `{"deleted":true}`

**Commit:** `feat(server): wire bookmarks CRUD routes`

---

## Task 3: Client session tracker

**Files:**
- Create: `host/public/lib/session.ts`
- Modify: `host/public/panels/hookpatch.ts` (call `session.record*` after successful RPC)

Tracker exposes:

```ts
export interface HookEntry { className: string; methodName: string; mode: "log" | "noop" | "forceReturn"; value?: unknown }
export interface PatchEntry { kind: "static"; className: string; field: string; value: unknown }

export function recordHook(e: HookEntry): void;
export function recordPatch(e: PatchEntry): void;
export function listHooks(): HookEntry[];
export function listPatches(): PatchEntry[];
export function clearSession(): void;  // called on detach
```

Module-level arrays. Dedupe on push (same className+methodName replaces prior entry). `clearSession` wipes both arrays and is wired to `onWsEvent(detached)` in main.ts.

In `hookpatch.ts`, after a successful `hook` / `replaceNoop` / `forceReturn` / `patchStatic` RPC, call `recordHook` / `recordPatch` accordingly.

**Verification:** `npm run build:ui` exits 0. After installing a hook via the UI, `localStorage` stays empty (we don't persist session state — just in-memory), but `session.listHooks()` returns the entry.

**Commit:** `feat(ui): session tracker for active hooks and patches`

---

## Task 4: Bookmarks panel

**Files:**
- Create: `host/public/panels/bookmarks.ts`
- Modify: `host/public/index.html` (add "bookmarks" tab in sidebar)
- Modify: `host/public/main.ts` (route sidebar tab)

**Tab button:**

```html
<div class="tabs" data-tabs="sidebar">
  <button class="tab active" data-tab="processes">processes</button>
  <button class="tab" data-tab="explorer">explorer</button>
  <button class="tab" data-tab="bookmarks">bookmarks</button>
</div>
```

**Panel (`bookmarks.ts`):**

Shows a list of bookmarks from `GET /api/bookmarks`, each row displaying name, processName, updatedAt. Actions on each row:
- **LOAD** — fetch the full bookmark, then re-apply every hook, patch, and pin via RPC calls in sequence. Brief per-step log to the events panel.
- **DELETE** — confirm then `DELETE /api/bookmarks/:slug`.

Top controls:
- **SAVE CURRENT** — prompts for a name (prefilled from the attached process), gathers session + watchlist state via `session.listHooks()`, `session.listPatches()`, `rpcCall("listPins")`, then `POST /api/bookmarks/:slug` with the body.
- **EXPORT** — JSON download of all bookmarks.
- **IMPORT** — file input, upload a JSON file (either a single bookmark or an array), save each.

Layout: `.panel` + `.section-header`s. Rows styled as mini-readouts (monospace, with tag for process name).

Target ~150 lines.

**Verification:** `npm run build:ui` exits 0. Switching to bookmarks tab shows an empty list. Clicking SAVE CURRENT with an attached process writes a file to `.toolkit-data/bookmarks/`.

**Commit:** `feat(ui): add bookmarks panel with save/load/delete/export/import`

---

## Task 5: Auto-offer matching bookmark on attach

**Files:**
- Modify: `host/public/main.ts` (subscribe to attach event, check for matching bookmark)
- Modify: `host/public/panels/bookmarks.ts` (expose `findByProcess(name)` + `loadBookmark(slug)`)

When the WS `attached` event fires, call `listBookmarks()` client-side (via the REST API) and filter by `processName === attachedInfo.name`. If 1+ matches, show a lightweight toast at the bottom of the header: `▸ preset available for Dofus.exe — LOAD ▪ DISMISS`. Click LOAD → run the load routine; click DISMISS → hide for this session.

If 2+ matches, offer the first; note in the toast "(+N other presets — see Bookmarks tab)".

**Toast styling:** re-use `.panel` + `.section-header` inside a fixed-position div at the top-center of the main area. Fade out after 10s if untouched.

**Verification:**
- Save a bookmark for `FridaCobaye.exe`
- Detach + reattach → toast appears within 1s
- Click LOAD → previously-saved hooks/patches/pins re-apply and are visible

**Commit:** `feat(ui): auto-offer matching bookmark on attach`

---

## Task 6: Smoke test + tag

**Files:**
- Modify: `scripts/smoke.md` — append M3 section

**Append:**

```markdown
## M3 — Bookmarks / Presets

- [ ] Attach FridaCobaye.exe, capture Player, pin `health`, install a hook on `TakeDamage`, patch `totalPlayersAlive=999`
- [ ] Open Bookmarks tab, click SAVE CURRENT, name "fc-basic"
- [ ] `.toolkit-data/bookmarks/fc-basic.json` exists with pins + hooks + patches
- [ ] Click DELETE on the row — file removed, row disappears
- [ ] Re-save, detach, reattach → toast appears at top of main area
- [ ] Click LOAD in toast → hook re-installed, patch reapplied, pin recreated
- [ ] EXPORT downloads a JSON with the single bookmark
- [ ] IMPORT with the same JSON (rename test) creates a new entry
- [ ] Detach → session hooks/patches cleared; next SAVE CURRENT produces empty lists (still saves, just empty bookmark)
```

**Verification:** Tag:
```bash
git tag -a m3-bookmarks -m "M3 complete: bookmarks with disk persistence, auto-offer, export/import"
```

**Commit:** `docs: append m3 smoke checklist`

---

## Self-Review

**Spec coverage (M3 row):**
- "One preset per game (key: process name)" → Task 4 (save/load) ✓
- "Contents: favorite hooks, favorite patches, default watchlist" → Tasks 3 (tracker) + 4 (save bundle) ✓
- "Load preset re-applies everything in one action" → Task 4 LOAD ✓
- "Auto-detect when the attached process matches" → Task 5 ✓
- "Export/import JSON" → Task 4 ✓

**Placeholder scan:** None. Every step has exact code or precise instructions.

**Ambiguity:**
- The param-route helper adds keys `GET_param`, `POST_param`, `DELETE_param` to the routes object. Explicit enough.
- Bookmark slug vs name: name is user-chosen, slug is derived. UI shows name, API uses slug. Clear.

**Files stay under 200 lines:** `persistence.js` ~55 lines; `router.js` grows from 34 → ~50; `bookmarks.ts` ~150; `session.ts` ~50.
