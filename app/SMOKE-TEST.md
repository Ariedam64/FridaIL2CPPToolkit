# Smoke test — Frida IL2CPP Toolkit v2.0 web app

Run from `app/`:

```bash
npm run dev
```

Then open http://localhost:5173 in a browser. Walk through:

1. **Process picker** — overlay appears at boot when no profile attached.
2. **Attach** — pick a process (e.g. Dofus.exe). Titlebar shows "connected", Process Explorer populates with assemblies.
3. **Filter** — type a substring in the explorer filter input → live-filtering of visible nodes.
4. **Class detail** — click a class → Class Detail renders Fields + Methods sections with parsed types + names.
5. **Hook a method** — 🪝 button → prompt for template (log/log-stack/noop) → events appear in right-panel Stream tab.
6. **Summary tab** — switch tab → counts per hook (sorted by hits).
7. **Hooks tab** — switch tab → list of installed hooks with Uninstall/Delete buttons.
8. **Detach + re-attach** — Attach button or Ctrl+K → Detach → re-attach to SAME process → hooks reappear (disarmed) on the SAME profile.
9. **Command palette ⌘K** — Ctrl+K (or Cmd+K) → palette opens. Type a class name (label or obf), Enter to navigate.
10. **Bookmarks page** — bookmark a class via class detail (⭐ button), then navigate to Bookmarks page → entry visible.
11. **Migrations page** — empty unless current build was derived from a previous one.
12. **Auto-revert** — try hooking a property getter on a class that shares a vtable slot with System.Reflection types (e.g., `get_kamas` on a class with such inheritance). The wrapper auto-reverts on lookup error; a synthetic event appears in the Hook Log Stream tab as a red row "auto-reverted (lookup-error): ...", and a `console.warn` is logged to the browser DevTools.

## Persistence

```bash
cat ~/.frida-toolkit/profiles/<game>/<buildId>/plugins/hooks/storage.json
```

The hooks defined via the UI should be in there with the right `className` (full namespace-qualified, not short obf).

## Network plugin (v1.2)

**Setup**: build the agent + frontend (`npm run build:rpc` at repo root, `npm run build` in `app/`), run `npm start`, attach to a Unity IL2CPP process.

### Test 13 — Auto-detect on Unity vanilla
1. Attach to a Unity vanilla game with Google.Protobuf.
2. Click the ⇄ Network nav icon.
3. **Expect**: status bar shows "Disarmed (N templates suggérés)" if Google.Protobuf was detected, or "Disarmed — configure manually" otherwise.
4. Click ⚙ Configure → see auto entries (disabled by default).

### Test 14 — Manual config wizard (Dofus path)
1. Attach to Dofus.
2. ⇄ Network → ⚙ Configure → **+ Add manual**.
3. Fill: direction=send, ns=(empty), class=`ecu`, method=`xbe`, signature=`(Google.Protobuf.IMessage):System.Void`, paramIndex=0.
4. Click Validate → expect ✓ valid.
5. Click "Add to list" → entry appears in the list.
6. Click Save.

### Test 15 — Live capture
1. Configure at least one entry, ensure it's enabled.
2. Click ▶ Start in the sidebar footer.
3. **Expect**: status flips to "🟢 Armed (N hooks)". Frames start arriving in the Stream tab.
4. Move/interact in the game → see corresponding frames.

### Test 16 — Side-panel detail (variant A)
1. Click any frame in the Stream → side-panel slides in from the right.
2. **Expect**: pretty-print indented view, nested fields collapsible, kind colors visible (int=blue, string=green, bool=orange, …).
3. Click "Expand all" / "Collapse all" → toggles all branches.
4. Click "Copy JSON" → frame JSON is in clipboard.

### Test 17 — Summary tab
1. Switch to Summary tab.
2. **Expect**: table of types with counts split by direction.
3. Click any row → switches to Inspector pre-filled with that type.

### Test 18 — Inspector tab
1. Switch to Inspector tab.
2. Pick a type from the dropdown.
3. **Expect**: table of last 50 instances, columns = field names, rows = timestamps.
4. **Expect**: cells whose value differs from the previous instance of the same direction are highlighted (indigo bg).
5. Click any cell → modal opens with full detail (variant A).

### Test 19 — Sidebar tree + filter
1. In the sidebar filter, type a substring of a known type.
2. **Expect**: tree filters to matching types only. Filter also applies to Stream/Summary tabs (sharedFilter).
3. Click a type in the tree → switches to Inspector pre-filled.

### Test 20 — Stop / Clear / Export
1. Click ⏸ Stop → status flips to "⚪ Disarmed". No new frames arrive.
2. Click Clear → ring buffer empties, Stream and Summary go empty.
3. Capture more, then click Export NDJSON → file downloads.

### Test 21 — Rename integration with labels
1. In Stream, click a frame → side-panel opens.
2. Click "Rename type" → prompt asks for new name. Type something readable (e.g. `MapMovement`) and confirm.
3. **Expect**: the type appears with the new name in the sidebar tree, in Stream rows, in Summary, and in **Process Explorer** (proof of `labels.ts` integration).

### Test 22 — Persistence across attach
1. Configure entries, click Save.
2. Detach (red badge / "disconnected").
3. Re-attach to the same process → status shows "Disarmed (config: N entries)" — your config survived.

### Test 23 — Anti-flood auto-revert
1. Configure an entry against a class whose method is hot but throws (use a wrong signature on purpose).
2. Start → expect a `network-auto-revert` event after 50 throws/sec, status reverts to disarmed for that entry.
3. Open Configure → that entry is now ❌ stale.

## v1.4 Plugin Scripts (2026-05-07)

This section is to be filled by the user during manual smoke testing on a real IL2CPP target.

### Setup
1. Start backend: `cd app && npm run dev`
2. Attach to a Unity/IL2CPP target via the web-app at `http://localhost:3001`.
3. After attach, confirm the profile dir contains:
   - `<profile>/plugins/scripts/_types/toolkit.d.ts` (auto-generated)
   - `<profile>/plugins/scripts/tsconfig.json` (auto-generated)

### Authoring
1. Create `<profile>/plugins/scripts/auto-travel.ts`:
   ```ts
   import { defineScript } from "@toolkit/scripts";

   export default defineScript({
       name: "autoTravel",
       description: "Travel to a specific map by mapId.",
       params: { mapId: { type: "number", label: "Map ID", required: true } },
       run: async ({ mapId }, toolkit) => {
           const player = await toolkit.instances.find("PlayerManager");
           toolkit.log("currentMapId before:", await toolkit.instances.read(player, "currentMapId"));
           const mgr = await toolkit.instances.find("MapManager");
           await toolkit.instances.call(mgr, "TravelTo", [mapId]);
           return `→ map ${mapId}`;
       },
   });
   ```
2. Open the dir in VSCode → confirm autocomplete works on `toolkit.*`.

### Smoke checklist
- [ ] Profile bootstrap emits `_types/toolkit.d.ts` + `tsconfig.json`
- [ ] Hot-reload picks up new file on save (~300ms)
- [ ] `autoTravel` appears in the Scripts page list
- [ ] Run with valid `mapId` triggers in-game travel
- [ ] Compile error → ⚠ in list, error visible in detail
- [ ] Runtime error → stack-trace points to `.ts` source line (not JS)
- [ ] VSCode autocomplete works on `<profile>/plugins/scripts/` after first attach

## v1 Dofus Plugin — Map Feature (2026-05-08)

This section is to be filled by the user during manual smoke testing on a real Dofus process.

### Setup
1. Run `cd app && npm run dofus:build-data` once (requires `.toolkit-data/datacenter/` populated with `MapsInformationDataRoot.json`, `AreasDataRoot.json`, `SubAreasDataRoot.json`, `WorldMapsDataRoot.json` + `dofus-app/data/canonical-coords-wm-*.json` files).
2. Confirm `app/plugins/dofus/data/maps/` contains ~17k JSON files and `maps-information.json` + `areas.json` were generated.
3. Start backend: `cd app && npm run dev`.
4. Open the web-app at `http://localhost:3001`.

### Smoke checklist — page load
- [ ] Click the Dofus crown icon in the nav.
- [ ] Click the "map" sub-tab. The page renders with: a dropdown labeled "World:" + a canvas area + a right side panel showing "Click a map to inspect."
- [ ] The dropdown is populated with multiple worlds (Amakna, Frigost, etc.) — at least 5 entries each with `(N)` map counts.
- [ ] The canvas displays a tiled view of all maps in the default world (Amakna = world 1) — colored rectangles arranged at their (posX, posY) coords. Roughly thousands of tiles visible.

### Smoke checklist — interaction
- [ ] Hover a tile → the right of the toolbar shows `(x, y) name` of the hovered map. Cursor stays a crosshair.
- [ ] Move the mouse off the canvas → hover info disappears.
- [ ] Click a tile → the side panel updates with: a header (map name), coord, and an iso cell-grid 14×40 below. Cells are colored: green walkable, marron walls, yellow farm cells, etc.
- [ ] The clicked tile gets a white outline on the world canvas (selected state).

### Smoke checklist — world switch
- [ ] Change the dropdown to another world (e.g. "Frigost"). The canvas re-renders with that world's maps; the side panel resets to the placeholder text.
- [ ] Click a map of the new world → cell-grid renders for that map.

### Smoke checklist — backend routes (curl)
- [ ] `curl http://localhost:3001/api/dofus/worlds` → returns `{worlds:[...]}` with mapCount per world.
- [ ] `curl 'http://localhost:3001/api/dofus/maps/list?world=1'` → returns `{world:1, maps:[~k entries]}`.
- [ ] `curl http://localhost:3001/api/dofus/maps/<knownMapId>` → returns `{mapId, name, posX, posY, neighbours, cells}` with cells.length === 560.
- [ ] `curl http://localhost:3001/api/dofus/maps/list?world=99` → returns 404 with `{error:"unknown world: 99"}`.

### Smoke checklist — error states
- [ ] If `app/plugins/dofus/data/maps-information.json` is renamed away, restart the backend, click "World:" dropdown → side panel shows "Failed to load worlds". Backend logs show `[dofus] DofusDataStore failed to load:`.
