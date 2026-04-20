# M2 — Watchlist + Copy-for-Claude Implementation Plan

**Goal:** Bring the LCD "readouts" — the Operator Console signature component — to life. Pin any field of a captured instance (or a static field) and see its value update ~2x per second, with delta since last tick. Plus: add "📋 Copy for Claude" buttons on logs, instance dumps, and the watchlist so the user can trivially share context with Claude.

**Architecture:**
- Frida side: one new module `src/rpc-agent/watchlist.ts` with 4 RPC methods (`pinField`, `unpin`, `listPins`, `clearPins`) + a single `setInterval(500ms)` that reads all pins and calls Frida's `send({type:'watchlist-tick', values})`.
- Host side: unchanged (WS already forwards `send()` payloads).
- Client side: new `host/public/panels/watchlist.ts` (renders the pinned readouts, subscribes to `watchlist-tick`, computes deltas), new `host/public/lib/clipboard.ts` (markdown formatters), pin buttons wired into the instance panel's "read field" action, and Copy-for-Claude buttons on the logs, watchlist, and future dumps.

**Tech:** No new deps. `navigator.clipboard.writeText` for the copy.

**Branch:** continue on `m1-foundation` (rename to `m1-m2-foundation` at end, or merge to main between milestones — decision at end).

**Scope boundary — what M2 does NOT do:**
- No freeze/write-lock on a pin (just monitoring; write happens via existing `writeField`).
- No persistence of pins across server restarts (that's M3 with bookmarks).
- No stack trace on hook (M5).

---

## Task 1: Watchlist Frida module

**Files:**
- Create: `src/rpc-agent/watchlist.ts`
- Modify: `src/rpc-agent/rpc-methods.ts` (aggregate new module)
- Modify: `src/rpc-agent/index.ts` (ensure `rpc.exports` includes watchlist methods)

**Implementation:**

Create `src/rpc-agent/watchlist.ts`:

```ts
// Watchlist — pin any field of a captured instance (or a static field)
// and tick its value every POLL_MS milliseconds via send({type:'watchlist-tick', values}).
import "frida-il2cpp-bridge";
import { stringifyValue, findClass } from "../lib";
import { getCapturedRaw } from "./registry";

const POLL_MS = 500;
type Pin = {
    id: string;
    kind: "instance" | "static";
    className: string;
    fieldName: string;
    label?: string;  // optional friendly label for UI
};

const pins = new Map<string, Pin>();
let timer: ReturnType<typeof setInterval> | null = null;
let nextId = 1;

function tick(): void {
    if (pins.size === 0) return;
    const values: Record<string, string> = {};
    Il2Cpp.perform(() => {
        for (const pin of pins.values()) {
            try {
                if (pin.kind === "instance") {
                    const inst = getCapturedRaw(pin.className);
                    if (!inst) { values[pin.id] = "<not captured>"; continue; }
                    values[pin.id] = stringifyValue(inst.field(pin.fieldName).value);
                } else {
                    const k = findClass(pin.className);
                    if (!k) { values[pin.id] = "<class not found>"; continue; }
                    values[pin.id] = stringifyValue(k.field(pin.fieldName).value);
                }
            } catch (e) {
                values[pin.id] = `<err: ${String(e).slice(0, 60)}>`;
            }
        }
    });
    send({ type: "watchlist-tick", values });
}

function ensureTimer(): void {
    if (timer) return;
    timer = setInterval(tick, POLL_MS);
}

function stopTimer(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

export function pinField(
    kind: "instance" | "static",
    className: string,
    fieldName: string,
    label?: string,
): Promise<{ id: string; label: string }> {
    return new Promise((resolve) => {
        const id = `p${nextId++}`;
        const finalLabel = label ?? `${className}.${fieldName}`;
        pins.set(id, { id, kind, className, fieldName, label: finalLabel });
        ensureTimer();
        console.log(`[watchlist] pinned ${finalLabel} as ${id}`);
        resolve({ id, label: finalLabel });
    });
}

export function unpin(id: string): Promise<boolean> {
    return new Promise((resolve) => {
        const had = pins.delete(id);
        if (pins.size === 0) stopTimer();
        if (had) console.log(`[watchlist] unpinned ${id}`);
        resolve(had);
    });
}

export function listPins(): Promise<Array<Pin>> {
    return Promise.resolve([...pins.values()]);
}

export function clearPins(): Promise<number> {
    return new Promise((resolve) => {
        const n = pins.size;
        pins.clear();
        stopTimer();
        resolve(n);
    });
}
```

Registry helper — add `getCapturedRaw` to `src/rpc-agent/registry.ts` (alongside existing `getCaptured`) that returns `null` instead of throwing (watchlist must survive missing captures without crashing the tick).

In `src/rpc-agent/registry.ts`, ensure there's an export like:

```ts
export function getCapturedRaw(className: string): Il2Cpp.Object | null {
    const inst = captured.get(className);
    return inst ?? null;
}
```

(Verify whether `captured` is exported directly or via accessors — Phase B used accessor functions. If so, `getCapturedRaw` already exists or needs adding.)

In `src/rpc-agent/rpc-methods.ts`, import and re-export the 4 new functions. In `src/rpc-agent/index.ts`, include them in `rpc.exports`.

**Verification:**
- `npm run build:rpc` exits 0.
- `grep -c 'pinField\\|unpin\\|listPins\\|clearPins' build/rpc-agent.js` ≥ 4.

**Commit:** `feat(rpc): add watchlist module with pin/unpin/list/clear + 500ms tick`

---

## Task 2: Typed WS event + helper in client

**Files:**
- Modify: `host/public/lib/ws.ts`

Add to the `WsEvent` union:

```ts
| { type: "message"; message: WatchlistTick | { type: string; [k: string]: unknown } }
```

Or more specifically, add a helper type and narrow in handlers. Concretely, update the file to:

```ts
export interface WatchlistTickPayload {
    type: "watchlist-tick";
    values: Record<string, string>;
}
```

The existing `WsEvent.message` shape `{type: string, [k]: unknown}` already accepts this. No change needed beyond exposing the type for subscribers to narrow on.

**Verification:** `npm run build:ui` exits 0.

**Commit:** `feat(ui): add WatchlistTickPayload type for ws subscribers`

---

## Task 3: Watchlist panel

**Files:**
- Create: `host/public/panels/watchlist.ts`
- Modify: `host/public/main.ts` (mount it)
- Modify: `host/public/index.html` (remove the placeholder "no pins yet" since the panel will render its own empty state)

**Implementation:** Create `host/public/panels/watchlist.ts` with:
- `mountWatchlist(container)` — renders empty state, subscribes to `watchlist-tick`, exposes nothing externally except the mount.
- Internal map: `pinId → { label, lastValue, el }`
- On each tick: update `el.querySelector('.v').textContent` with new value, compute delta (only for numeric values: e.g. `1000 → 1012` → show `+12` in green; `120 → 100` → `−20` in amber).
- Readout markup matches the theme:
  ```html
  <div class="readout" data-pin-id="p1">
    <span class="dot"></span>
    <span class="k">Player.kamas</span>
    <span class="v">1,284,392</span>
    <span class="d up">+12</span>
    <button class="btn unpin-btn" title="unpin">×</button>
  </div>
  ```
- "Add pin" is done via the instance panel (Task 4), not from within the watchlist itself. The watchlist shows only current pins.
- Public function `refreshFromServer()` — calls `listPins`, adds empty readouts for pins the server knows about but we don't (survives page reload).

**Mount from main.ts:** replace the existing placeholder `<div id="watchlist">…</div>` rendering with a call to `mountWatchlist($("#watchlist"))`.

**Verification:** `npm run build:ui` exits 0. Page loads with empty watchlist showing one idle "no pins yet" state.

**Commit:** `feat(ui): add watchlist panel with live readouts and delta display`

---

## Task 4: Pin button in instance panel "read field"

**Files:**
- Modify: `host/public/panels/instance.ts`

Add a new button in the "read field" action row: a small `📌` pin button alongside the existing `READ` button. It calls `pinField("instance", className, fieldName)` and shows a toast (or logs a line) on success.

Also add a section `pin static field`:
- Inputs: class, fieldName
- Button: `📌 pin static`

**Verification:** Pin a known field (e.g., after capturing a Player, pin `hp`) → watchlist shows a new readout that ticks every 500ms.

**Commit:** `feat(ui): add pin-to-watchlist buttons in instance panel`

---

## Task 5: Copy-for-Claude clipboard helper + buttons

**Files:**
- Create: `host/public/lib/clipboard.ts`
- Modify: `host/public/panels/logs.ts` (add "Copy session" button)
- Modify: `host/public/panels/watchlist.ts` (add "Copy state" button)

**Implementation:**

Create `host/public/lib/clipboard.ts`:

```ts
// Copy-for-Claude helpers. Produces compact markdown that fits the chat well.
export async function copyMarkdown(md: string, flash?: HTMLElement): Promise<void> {
    try {
        await navigator.clipboard.writeText(md);
        if (flash) {
            const prev = flash.textContent;
            flash.textContent = "✓ copied";
            setTimeout(() => { flash.textContent = prev; }, 1200);
        }
    } catch (e) {
        console.error("[clipboard] failed", e);
        alert("clipboard write failed: " + String(e));
    }
}

export function formatLogSession(entries: Array<{ ts: string; cls: string; text: string }>, limit = 50): string {
    const tail = entries.slice(-limit);
    const lines: string[] = [];
    lines.push("# Toolkit session log (tail)");
    lines.push("");
    lines.push("```text");
    for (const e of tail) lines.push(`[${e.ts}] [${e.cls}] ${e.text}`);
    lines.push("```");
    return lines.join("\n");
}

export function formatWatchlist(readouts: Array<{ label: string; value: string; delta?: string }>): string {
    const lines: string[] = [];
    lines.push("# Watchlist snapshot");
    lines.push("");
    lines.push("| field | value | Δ |");
    lines.push("|---|---|---|");
    for (const r of readouts) lines.push(`| \`${r.label}\` | \`${r.value}\` | ${r.delta ?? ""} |`);
    return lines.join("\n");
}
```

In `logs.ts`: add a button in the right-column header "📋 Copy session" that collects the current visible log entries (walk the DOM for recent lines, or keep a ring buffer) and copies the markdown. Use `formatLogSession`.

In `watchlist.ts`: add a button "📋 Copy state" next to the watchlist header that iterates current readouts and copies the markdown via `formatWatchlist`.

**Verification:**
- Click "Copy session" → clipboard contains markdown starting with `# Toolkit session log (tail)`.
- Click "Copy state" when at least one pin exists → clipboard contains the watchlist table.

**Commit:** `feat(ui): add copy-for-claude buttons (logs session, watchlist snapshot)`

---

## Task 6: Smoke test against FridaCobaye.exe

**Files:**
- Modify: `scripts/smoke.md` — append an M2 section

**Append:**

```markdown
## M2 — Watchlist + Copy-for-Claude

Setup: attach to FridaCobaye.exe, capture Player via GC or hook.

- [ ] Pin a numeric field (e.g. `Player.hp`) — watchlist shows a new readout that pulses
- [ ] Value updates every ~500ms
- [ ] Δ shows "+N" or "−N" when the in-game value changes
- [ ] Click × to unpin — readout disappears; tick stops when last pin removed
- [ ] Pin 5 fields — all update in sync, one timer (Frida CPU impact minimal)
- [ ] "Copy session" on logs — clipboard gets markdown log tail
- [ ] "Copy state" on watchlist — clipboard gets markdown table
- [ ] Reload page → watchlist empty (pin persistence is M3, not M2)
- [ ] Detach then re-attach → existing pins silently become `<not captured>` readouts (graceful)
```

**Commit:** `docs: append m2 smoke checklist`

---

## Self-Review

1. **Spec coverage (M2 row in spec §7):**
   - "Watchlist (new signature panel)" → Task 1 (backend) + Task 3 (frontend) + Task 4 (pin UX) ✓
   - "Copy-for-Claude everywhere" → Task 5 (logs + watchlist; instance dump deferred to M4 where Inspector lands, since dump currently renders directly into logs which is already covered by "Copy session") ✓
   - WS plumbing → Task 2 ✓
   - "Acceptance: pin 3 fields on Dofus, see them tick, copy as markdown" → Task 6 ✓

2. **Placeholder scan:** No TBD / TODO. Every file has exact content or precise inline instructions. The only "figure it out" spot is the `getCapturedRaw` accessor in registry.ts — Task 1 acknowledges the Phase B-B deviation (accessors instead of raw export) and says to verify.

3. **File size targets:** All new files well under 200 lines (`watchlist.ts` Frida ~90 lines, `watchlist.ts` UI ~100 lines, `clipboard.ts` ~30 lines).

4. **Ambiguity:** "Copy session" in logs.ts needs a ring buffer or DOM walk to collect entries — the plan says "keep a ring buffer" OR "walk the DOM". The implementer picks one. Recommendation: small module-level array capped at 200 entries, populated in the existing WS handler. Flag this choice in the commit message.
