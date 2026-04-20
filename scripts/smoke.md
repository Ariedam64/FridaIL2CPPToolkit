# M1 Smoke Test

Run this checklist before tagging `m1-foundation`. Target: `FridaCobaye.exe` (existing preset).

## Setup

```bash
npm install                     # first time only
npm run build:all               # builds rpc-agent + all tools + UI
npm run host                    # starts node host/server.js on :3000
```

- [ ] `npm run build:all` completes with exit 0
- [ ] `npm run host` outputs the URL (`http://localhost:3000`)
- [ ] Browser opens — **three-column Operator Console layout** appears
  - Header bar at top with `◉ IL2CPP Operator` title + status pill "not attached"
  - Left column: sidebar with `processes` / `explorer` tabs
  - Middle column: main panel with `search / instance / hook & patch / socket` tabs
  - Right column: `live` section with idle readout + `events` section below
- [ ] Amber-on-charcoal palette, scan-lines subtly visible on dark surfaces
- [ ] Fonts: Inter for UI, JetBrains Mono for data (no FOIT — default system font shouldn't linger)

## Connection

Launch `FridaCobaye.exe` (the test target) before proceeding.

- [ ] Process list populates in the sidebar within ~2 seconds
- [ ] Filter box narrows the list on input
- [ ] `↻` refresh button reloads the list
- [ ] Clicking `FridaCobaye.exe` (or its row) → status pill turns **green with pulsing dot** and shows `name · pid`
- [ ] Event log in the right column shows `[agent ready]` message
- [ ] `detach` button becomes enabled after attach, disabled after detach
- [ ] `reload` button — clicking re-reads `build/rpc-agent.js` and reloads the agent without full detach

## Search

Attached to `FridaCobaye.exe`.

- [ ] `full analyze · run analyze` → logs stream (assemblies, classes, MonoBehaviours listed)
- [ ] `by name` with `Player` → results logged
- [ ] `by field` with `Int32` / `hp` → matches logged
- [ ] `by method` with `Boolean` return → matches logged
- [ ] `string in memory` with a known literal (e.g. `"FridaCobaye"` or `"GameManager"`) → UTF-8 + UTF-16 hits logged
- [ ] `dump class · full` with a known class → every field logged, clickable class links work

## Instance

- [ ] `listInstances("Player")` → returns list of live instances
- [ ] `captureViaGC("Player", 0)` → captured summary appears
- [ ] `listCaptured()` → shows the captured Player
- [ ] `dumpInstance("Player")` → all fields logged
- [ ] `readField("Player", "hp")` → returns current value
- [ ] `writeField("Player", "hp", 9999)` → value changes; `readField` confirms
- [ ] `callInstance("Player", "<someMethod>", "[]")` → works
- [ ] `readList(...)` on a known List<T> field → enumerates items
- [ ] `enumerateList(...)` with method names comma-separated → calls each on every element

## Hook & Patch

- [ ] `hook("Player", "TakeDamage")` → on next damage event, a hook log line appears (orange left-border)
- [ ] `replaceNoop("Player", "TakeDamage")` → subsequent damage has no effect
- [ ] `forceReturn("Player", "IsAlive", true)` → method always returns true
- [ ] `patchStatic("Player", "totalPlayersAlive", 999)` → value persists, visible via static dump
- [ ] `callStatic(...)` with JSON args array → works

## Socket (network)

Skip if no Dofus instance — `FridaCobaye.exe` has no `ecu.xbe`.

- [ ] `startNetworkCapture("ecu", "xbe")` with Dofus → outbound messages stream in the socket log
- [ ] Filter input narrows visible rows
- [ ] `clear` wipes the log
- [ ] `stopNetworkCapture` reverts the hook

## Explorer

- [ ] Switch to sidebar `explorer` tab → "by assembly" mode loads assembly list with class counts
- [ ] Expanding an assembly → namespaces listed
- [ ] Expanding a namespace → classes listed (with `.tag` badges)
- [ ] Switching mode to "by inheritance" with `UnityEngine.MonoBehaviour` + `go` → subclasses listed
- [ ] Filter box narrows visible entries

## Visual / theme

- [ ] **Status pill**: gray when not attached, pulsing green with dot when attached, red if disconnected (simulate by killing the target)
- [ ] **Watchlist placeholder**: one idle readout with dim gray dot, no animation
- [ ] **Tabs**: active tab has amber underline; hover darkens others
- [ ] **Buttons**: square, compact uppercase text, border brightens on hover, amber fill on click
- [ ] **Inputs**: inset dark background, amber focus ring, monospace font for code fields
- [ ] **Scan-lines**: barely visible 1% amber horizontal lines on dark surfaces
- [ ] **Scroll bars**: narrow, dark, with amber-tinted thumb
- [ ] **No harsh drop shadows, no rounded Material-looking buttons, no blue-accent VSCode-default anywhere**

## Regressions check

Walk through every action once more rapidly. Any feature that was in the old UI but now errors / does nothing / is missing is a regression. Record and file a fix task before tagging.

## If all pass

```bash
git tag -a m1-foundation -m "M1 complete: modular structure + Operator Console theme + all existing panels migrated"
git log --oneline m1-foundation..HEAD   # should be empty
```

Then, open a session with Claude to start on the M2 plan (Watchlist + Copy-for-Claude).

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
