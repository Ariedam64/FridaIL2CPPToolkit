# Frida IL2CPP Toolkit — Refactor Design

**Date** : 2026-04-20
**Status** : draft (awaiting user review)
**Scope** : full refactor of `host/` (server + web UI), extension of `rpc-agent.ts` with new features. Existing `src/lib/` and `src/tools/` one-shot scripts are kept as-is.

---

## 1. Intent

The toolkit is a local, single-user dev tool used to explore, hook, and patch Unity IL2CPP games via Frida. The primary user is **learning** IL2CPP modding and **regularly drives the toolkit with Claude as copilot** — this shapes every design decision.

Two consequences:

1. **Drivability by Claude** — structured RPC, descriptive outputs, copy-for-Claude helpers everywhere so the user can share context with Claude without manual copy-paste gymnastics.
2. **Beginner friendliness** — guided workflows, tooltips that explain *why*, discoverable entry points, no jargon-only labels.

The toolkit must feel like a **piloted instrument panel** — quiet when idle, vibrant when data flows. This is captured in the "Operator Console" visual direction.

---

## 2. Scope

**In scope:**
- Complete rewrite of `host/public/` (HTML + JS + CSS → TypeScript modules + design-system CSS)
- Modular refactor of `host/server.js`
- Modular refactor of `src/tools/99-rpc-agent.ts` into `src/rpc-agent/` with new modules
- 4 new features (memory scanner, diff instances, bookmarks/presets, dump-to-file)
- 4 new UX features (watchlist, inspector tree, copy-for-Claude, logs filter)
- 1 enhancement (stack trace on hook)
- New visual theme "Operator Console"

**Explicitly out of scope:**
- Changes to `src/lib/` (helpers work as-is)
- Changes to `src/tools/01-…06-*.ts` (one-shot scripts stay as reference)
- Light mode
- Framework migration (stays vanilla TypeScript, no Preact/React/Vue)
- Desktop packaging (stays browser-based, Tauri deferred)
- Mobile/Android host
- Multi-user / auth (local tool only)
- Script recorder, string refs (dropped after Q2)

---

## 3. File Structure

```
F:/FridaIL2CPPToolkit/
├── src/
│   ├── lib/                 ← UNCHANGED (existing helpers)
│   ├── tools/               ← UNCHANGED (01…06 one-shot scripts)
│   ├── presets/             ← UNCHANGED
│   └── rpc-agent/           ← NEW: rpc-agent.ts split into modules
│       ├── index.ts         ← main export (frida-compile target)
│       ├── registry.ts      ← captured-instances registry (extracted)
│       ├── scanner.ts       ← memory scanner (NEW)
│       ├── watchlist.ts     ← pinned-fields poller (NEW)
│       ├── diff.ts          ← instance snapshot + diff (NEW)
│       ├── dump-export.ts   ← streaming dump for file export (NEW)
│       ├── stacktrace.ts    ← backtrace-enabled hook (NEW)
│       ├── network.ts       ← ecu.xbe network capture (extracted)
│       └── rpc-methods.ts   ← aggregates all modules into rpc.exports
│
├── host/
│   ├── server.js            ← thin entry point, delegates to modules
│   ├── lib/
│   │   ├── frida-bridge.js  ← attach / detach / callRpc
│   │   ├── router.js        ← route table (HTTP)
│   │   ├── persistence.js   ← bookmarks + dumps in .toolkit-data/
│   │   └── ws.js            ← WebSocket broadcast
│   └── public/
│       ├── index.html       ← layout shell (3-column)
│       ├── main.ts          ← bootstrap, panel orchestration
│       ├── theme.css        ← Operator Console design tokens + components
│       ├── lib/
│       │   ├── rpc.ts       ← HTTP client for /api/call
│       │   ├── ws.ts        ← WebSocket client + typed event bus
│       │   └── store.ts     ← minimal subscribe/notify state manager
│       └── panels/
│           ├── connection.ts   ← process picker, attach/detach
│           ├── explorer.ts     ← assembly/inheritance tree (existing, restyled)
│           ├── scanner.ts      ← memory scanner (NEW)
│           ├── watchlist.ts    ← pinned live readouts (NEW, always visible)
│           ├── inspector.ts    ← navigable instance tree (NEW)
│           ├── diff.ts         ← snapshot comparator (NEW)
│           ├── hookpatch.ts    ← hook/patch with stack trace (enhanced)
│           ├── logs.ts         ← filtered event stream (enhanced)
│           └── bookmarks.ts    ← per-game presets (NEW)
│
├── .toolkit-data/           ← NEW, gitignored (persistent state)
│   ├── bookmarks/           ← {gameName}.json
│   └── dumps/               ← {timestamp}-{classname}.md
│
└── docs/superpowers/specs/  ← this file and future specs
```

**Size targets:**
- No file over ~200 lines
- `rpc-agent/*.ts` : 80-150 lines each
- `public/panels/*.ts` : 100-150 lines each

---

## 4. Features — Panels

### Layout

Three zones, always visible:

```
┌─────────────────────────────────────────────────────────────┐
│ HEADER · status · attached process · detach · reload        │
├──────────────┬─────────────────────────────┬────────────────┤
│              │                             │                │
│   SIDEBAR    │       ACTION PANEL          │   SIDE LIVE    │
│              │  (tabs: search / scanner /  │                │
│  ▸ Processes │   inspect / diff / hook /   │  ▸ Watchlist   │
│  ▸ Explorer  │   socket)                   │   (pulsing)    │
│  ▸ Bookmarks │                             │                │
│              │                             │  ▸ Live logs   │
│              │                             │   (filterable) │
└──────────────┴─────────────────────────────┴────────────────┘
```

### Panels

**🔍 Search** *(existing, restyled)* — find-class, find-by-field, find-by-method, dump-class. Same functionality, Operator Console styling.

**🎯 Scanner** *(NEW)*
- Input: value (int / float / string) + type hint
- Initial scan → list of candidates (address + owning class + field name when IL2CPP-aware)
- Refiner loop: user changes value in-game → "next scan" with new value → list narrows
- Per-candidate: `📌 pin to watchlist`, `❄ freeze` (write-lock at current value)
- IL2CPP-aware first pass: scans known managed instances before brute-forcing memory (order of magnitude faster)

**📦 Inspector** *(NEW, replaces the instance tab)*
- Navigable tree of a captured instance
- Click a field whose type is a reference → expand in tree
- Per-field inline actions: `👁 watch` / `✏ edit` / `🔍 capture`
- `List<T>` fields: show size, expand N elements (configurable)
- `📋 Copy for Claude` button → markdown dump of current view to clipboard

**🆚 Diff** *(NEW)*
- `Snapshot T0` button on current captured instance → full state capture
- After user action in-game: `Snapshot T1`
- Table: field · T0 · T1 · Δ, sortable by "changed first"
- `📋 Copy diff for Claude` button

**⚡ Hook & Patch** *(existing, enhanced)*
- New: `capture stack trace` checkbox per hook → IL2CPP backtrace pushed in fire event
- New: `capture args as snapshot` → pushes args into Inspector for deep inspection
- Applied patches are tagged and appear in Bookmarks; one click to toggle

**🔌 Socket** *(existing, restyled)* — outbound capture via `ecu.xbe(IMessage)` hook. Same functionality.

**🔖 Bookmarks** *(NEW, in sidebar)*
- One preset per game (key: process name), user-overridable
- Contents: favorite hooks, favorite patches, default watchlist
- `Load preset` re-applies everything in one action
- Auto-detects when the attached process matches a known preset → offers "load?" toast
- Export/import JSON for sharing

**📜 Watchlist** *(NEW, always-visible side panel)*
- Pinned fields, value refreshed every ~500ms (adjustable)
- LCD-pulse styling (the Operator Console signature)
- Delta-since-last-tick shown briefly
- `❄ freeze` per pin (write-locks the value)

**📋 Live logs** *(existing, enhanced)*
- Regex filter + type tags (log / hook / rpc / net)
- `📋 Copy session for Claude` → markdown export of last N events

---

## 5. Data Flow

Three channels between browser and Frida:

```
      ┌─────────────┐                         ┌──────────────┐
      │  BROWSER    │                         │   NODE HOST  │
      │  (panels)   │                         │  (server.js) │
      └──────┬──────┘                         └──────┬───────┘
             │                                       │
             │   ①  HTTP POST /api/call              │       ┌─────────┐
             │ ────────────────────────────────────▶ │ ────▶ │  FRIDA  │
             │      { method, args }                 │  RPC  │  AGENT  │
             │ ◀──────────────────────────────────── │ ◀──── │ (target)│
             │      { result }         (sync reply)  │       └─────────┘
             │                                       │             │
             │   ②  WebSocket ws://…/ws              │ ◀───────────┘
             │ ◀──────────────────────────────────── │  async events
             │      { type, payload }                │  (hook fires,
             │      push async                       │   scan progress,
             │                                       │   console.log…)
             │                                       │
             │   ③  HTTP /api/bookmarks /api/dumps   │      ┌─────────────┐
             │ ──────────────────────────────────── ▶│ ───▶ │ .toolkit-   │
             │                                       │ fs   │  data/      │
             │ ◀──────────────────────────────────── │ ◀─── │ (disk)      │
```

**① Synchronous RPC (HTTP)** — one-shot actions (find-class, scan-initial, capture, dump, hook install). Existing `/api/call` extended with new methods.

**② WebSocket push** — asynchronous streams:
- `{type:'log', level, payload}` — console.log from target
- `{type:'hook-fire', method, args, retval, stack?}` — hook triggered
- `{type:'watchlist-tick', values:{pinId:value}}` — periodic pin refresh (single timer Frida-side)
- `{type:'scan-progress', found, scanned}` — long scan in progress
- `{type:'scan-done', candidates}` — scan complete
- `{type:'attached'|'detached'}` — connection state

Client-side: one typed event bus (`host/public/lib/ws.ts`), panels subscribe only to their types.

**③ Disk persistence** — `host/lib/persistence.js`:
- `GET/POST/DELETE /api/bookmarks/:name` → CRUD on `.toolkit-data/bookmarks/<name>.json`
- `POST /api/dumps` → server writes payload to `.toolkit-data/dumps/<ISO>-<className>.md`, returns path
- Bookmarks are versioned plain JSON (hand-editable)

### Watchlist implementation

Frida side: single `Map<pinId, {className, fieldPath}>`. One `setInterval(500ms)` reads all values, pushes `{type:'watchlist-tick', values}`. **One timer for all pins** (not one per pin) — simpler, lower overhead.

Server side: broadcasts verbatim on WS.

Browser side: watchlist panel subscribes, updates LCD readouts, computes delta locally (current vs previous tick).

---

## 6. Design System — Operator Console

### Intent statement

An instrument panel a person pilots for hours. **Calm when nothing moves, vibrant when data pulses** (hook fires, value changes). Warm, tactile, slightly retro-instrumented. The user feels they are operating a machine, not clicking through a dashboard.

### Signature element

**LCD readouts** — every piece of "live" data (watchlist values, hook-fire counters, scan progress, active-patch badge, attached-process indicator) renders through the same `.readout` component: monospace amber value + pulsing orange dot when fresh + muted label. This motif appears across every panel and is the single strongest visual identity marker.

### Defaults rejected

1. **Dark-gray + blue-accent developer tool** (VSCode / GitHub Dark default) → **warm amber on charcoal**
2. **Colored sidebar fragmenting the space** → **same surface tone everywhere**, separation via low-opacity borders
3. **Rounded Material/shadcn buttons** → **near-square buttons** with compact lettering, instrument-panel feel

### Tokens

```css
:root {
  /* Surfaces — same hue, lightness step */
  --surface-0: #0c0d0f;      /* canvas */
  --surface-1: #14161a;      /* panel */
  --surface-2: #1b1e23;      /* dropdown, elevated */
  --surface-3: #232731;      /* focused input */
  --surface-inset: #0a0b0d;  /* input "inset" (darker than parent) */

  /* Borders — always rgba */
  --border-soft:   rgba(232, 184, 124, 0.06);
  --border:        rgba(232, 184, 124, 0.12);
  --border-strong: rgba(232, 184, 124, 0.22);
  --border-focus:  rgba(255, 122, 45, 0.60);

  /* Text — 4 strict levels */
  --ink-primary:   #ffd89c;   /* readouts, titles */
  --ink-body:      #e9cfa3;
  --ink-muted:     #a58a6a;
  --ink-disabled:  #564939;

  /* Accents */
  --accent:        #ff7a2d;   /* live, primary, focus */
  --accent-glow:   rgba(255, 122, 45, 0.35);
  --live:          #ff7a2d;   /* alias for pulsing elements */
  --ok:            #7ed957;
  --warn:          #f5c518;
  --err:           #ff5a4a;

  /* Type */
  --font-ui:   'Inter', -apple-system, 'Segoe UI', sans-serif;
  --font-mono: 'JetBrains Mono', 'Consolas', monospace;

  /* Spacing — base 4 */
  --s-1: 4px;  --s-2: 8px;  --s-3: 12px;  --s-4: 16px;
  --s-5: 20px; --s-6: 24px; --s-8: 32px;  --s-10: 40px;

  /* Radius — near-square, instrument vibe */
  --r-sm: 2px; --r-md: 4px; --r-lg: 6px;

  /* Motion */
  --ease:  cubic-bezier(.2,.7,.2,1);
  --fast:  120ms;
  --pulse: 1.6s;
}
```

### Typography — 3 roles only

| Role | Font | Size/weight | Treatment |
|---|---|---|---|
| Section title | Inter 600 | 10px, letter-spacing 0.22em, uppercase | `--accent` |
| Body / labels | Inter 400-500 | 12.5-14px | `--ink-body` / `--ink-muted` |
| Data readout | JetBrains Mono 500-700 | 11-17px, letter-spacing 0.04em, tabular-nums | `--ink-primary` with subtle glow |

No serif. No display fonts. Single `Inter + JetBrains Mono` pairing.

### Depth strategy — borders-only + ambient scan-lines

No drop shadows. Elevation via:
1. Surface shift (`--surface-1 → --surface-2`)
2. Stronger border
3. Ambient 1% amber scan-lines overlay on dark surfaces (CRT hint)

### Signature components

- **`.readout`** — LCD pulse motif. Pulsing amber dot + mono-bold amber value + muted label.
- **`.section-header`** — `▸ TITLE · meta` uppercase tracked. Replaces all H1/H2/H3.
- **`.action-btn`** — square, `--surface-2` background, `--border`, hover → `--border-strong` + faint glow, active → `--accent` background / dark ink.
- **`.input`** — `--surface-inset` background (darker than parent = recessed), `--border`, focus → `--border-focus`. Mono for code fields.
- **`.tag`** — compact mono badge for deltas / states / types. 2px radius, 1px border.

---

## 7. Rollout — Milestones

Each milestone ships a usable baseline. No half-broken intermediates.

| # | Milestone | Contents | Acceptance |
|---|---|---|---|
| **M1** | Foundation | File-structure split (server + public + rpc-agent modules), `theme.css`, 3-column layout shell, existing panels re-rendered in new theme. No new features. | Attach/detach/hook/patch all work as before, visuals entirely new |
| **M2** | Watchlist + Copy-for-Claude | Signature `.readout` component wired; Frida-side single-timer poller; WS `watchlist-tick`; Copy-for-Claude buttons (logs, instance dump, watchlist) | Pin 3 fields on Dofus.exe, see them tick; copy them as markdown |
| **M3** | Bookmarks + persistence | `.toolkit-data/`, `/api/bookmarks` CRUD, preset auto-detect by process name, export/import JSON | Bookmark 2 hooks + 1 patch for a game, relaunch, load-preset reapplies all |
| **M4** | Scanner + Inspector + Diff | Three new panels sharing the captured-instances store | Memory-scan value, narrow via refiner, pin, inspect, diff before/after a game action |
| **M5** | Polish | Stack trace on hook, regex logs filter, dump-to-file, disconnected state, basic keybinds | All nice-to-haves wired; smoke test passes end-to-end |

Between milestones the toolkit is stable and shippable.

---

## 8. Error Handling

- **HTTP `/api/call` errors** (RPC failure, target error) → server returns 500 + `{error}`; frontend shows ephemeral red toast; panel retains prior state (no ghost-click).
- **WS disconnect** → persistent red bar in header `DISCONNECTED · reload?`; panels freeze last value; all live actions disabled until reconnect.
- **Frida agent crash inside an RPC method** → server catches, returns error, agent stays loaded (no forced reload).
- **No auto-retry.** User sees error and decides.
- **No defensive input validation on the frontend** — Frida/IL2CPP errors surface through the normal RPC error channel; invalid class names fail cleanly.

---

## 9. Testing

Minimalist strategy matching a local single-user dev tool:

- **No UI tests.** Validation = manual smoke test per milestone against `FridaCobaye.exe` (existing preset) then `Dofus`.
- **Unit tests only for pure functions** that warrant them: diff computation, scanner candidate filtering, markdown-export formatters. Co-located `*.test.ts`, runner = Node's built-in `node --test` (no Jest / Vitest / other framework dep).
- **Per-milestone smoke checklist** in `scripts/smoke.md` — attach, detach, pin/unpin, scan refiner, load preset, etc. — walked through by hand before marking a milestone done.

---

## 10. Non-Goals

- Matching any specific existing tool's feature surface (Cheat Engine, dnSpy, etc.). The scanner is IL2CPP-aware-first and doesn't aim for Cheat Engine's full feature set.
- Cross-game generality. The toolkit is tuned for Unity IL2CPP. Mono/IL2CPP detection stays with frida-il2cpp-bridge.
- Backwards compatibility with the old UI. This is a rewrite; anything running the old HTML stops working after M1.

---

## 11. Open Questions

- **Font loading** — Google Fonts online vs self-hosted woff2 in `host/public/fonts/`? Self-hosting means no external dep and works offline; costs ~150 KB static. **Recommendation: self-host.**
- **Bookmarks preset auto-detect scope** — only on attach, or also on detach-then-reattach? **Recommendation: every attach, with "don't ask again this session" dismiss.**
- **Scanner max RAM scan region** — cap scan size to avoid stalls? Probably yes, configurable. Default: skip regions > 256MB.

These will be resolved during M3/M4 implementation — not blockers for the plan.
