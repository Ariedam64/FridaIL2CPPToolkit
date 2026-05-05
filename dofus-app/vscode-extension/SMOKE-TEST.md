# Frida IL2CPP Toolkit Core — Smoke Test Checklist (v1)

Run this end-to-end after each significant change. Requires a Frida agent
running on `localhost:3001/api/call` attached to any IL2CPP process
(Dofus.exe is the reference target).

## Setup

- [ ] Frida is running and attached
- [ ] Open `dofus-app/vscode-extension/` in VSCode and press F5

## Connection + profile

- [ ] Status bar shows `⚡ <gameName> | <buildId-short>`
- [ ] No error toasts at startup
- [ ] `Frida: Show profile info` displays correct game name + build-id
- [ ] Profile directory exists at `~/.frida-toolkit/profiles/<game>/<build>/`
- [ ] `manifest.json` is created with all expected fields

## Process Explorer

- [ ] Sidebar (⚡ icon) → Process Explorer expands assemblies
- [ ] Expanding an assembly shows namespaces with class counts
- [ ] Expanding a namespace shows classes
- [ ] Click on a class opens the detail webview
- [ ] Webview shows class fields and methods (via dumpClassAsString)

## Rename live

- [ ] In the webview, click `Rename` → input `HaapiService` → save
- [ ] Class name in tree updates to `HaapiService`
- [ ] Webview header updates to `HaapiService [egq]` (or similar)
- [ ] Reopen VSCode, attach Frida → label is still there
- [ ] `~/.frida-toolkit/profiles/<game>/<build>/labels.json` contains the label

## Bookmarks + notes

- [ ] Bookmark a class via the webview button
- [ ] Bookmark appears in the Bookmarks sidebar panel
- [ ] Add a note via the webview button
- [ ] Note appears below the class header in the webview
- [ ] Reload VSCode → bookmark + note persist

## Search

- [ ] `Frida: Search...` (or Ctrl+Shift+F) opens Quick Pick
- [ ] Typing matches both obf names and labels
- [ ] Selecting a result opens the class detail

## Toggle obf names

- [ ] `Frida: Toggle obfuscated names` → tree now shows `HaapiService [egq]`
- [ ] Toggle again → tree shows `HaapiService` only

## Undo / redo

- [ ] Rename a class
- [ ] `Frida: Undo rename` → label removed
- [ ] `Frida: Redo rename` → label restored

## Import / export

- [ ] `Frida: Export labels` → save JSON
- [ ] Manually inspect: `schemaVersion: 1` + nested classes/methods/fields
- [ ] `Frida: Import labels` on a fresh profile → labels restored

## Migrations (cross-build)

- [ ] (If you have access to a different build) attach to it
- [ ] Status bar shows the new buildId
- [ ] Toast says "New build detected. Migrations from <previous> pending..."
- [ ] Migrations panel shows AUTO/REVIEW/LOST sections
- [ ] AUTO entries reference labels you set in the previous build
- [ ] (Future task) Click a REVIEW entry → opens migration-review webview

## Performance

- [ ] No noticeable hitch when renaming
- [ ] Tree expansion stays under 1s per level on a typical IL2CPP process
- [ ] Search Quick Pick opens within ~500ms after building the index

## No regressions vs. demo

- [ ] All commands accessible via `Ctrl+Shift+P` → typing `Frida`
- [ ] Status bar updates within 10s of Frida disconnect/reconnect

## Plugin Hooks (v1.1)

Pre-req : direct Frida mode (HTTP mode disables this plugin).

1. Attach to the target. The "Hooks" view appears in the Frida sidebar (empty).
2. Open Process Explorer → expand any class → right-click a method → "Frida: Hook this method..." → pick `log`. The hook appears in the Hooks tree with a filled circle (installed).
3. Open the Hook Log via Command Palette → "Frida: Hooks — Open Log". Trigger the method in-game; events scroll in the Stream tab. Switch to Summary — the hook shows a hit count.
4. Filter: type a substring of the class name in the filter input — only matching events stay.
5. Pause / Clear: pause halts new events from displaying (they keep being buffered in the bus); clear empties both stream + ring buffer.
6. Export JSON: click Export → save dialog → confirm a file is written with the buffered events.
7. Edit: right-click the hook in the tree → Edit → change template to `noop`. Verify hits in Stream now have empty args + null retval.
8. Toggle: click the inline toggle → tree icon goes hollow → no more events stream.
9. Detach (or restart the game) → re-attach → the Hooks tree shows the hook DISARMED (hollow circle). Click the toggle to install it again — events resume.
10. Switch builds: open a different Unity build of the game (or fake via gameNameOverride). The Hooks tree should be empty (per-profile isolation).
11. Clear all: command "Frida: Hooks — Uninstall all" → tree icons all go hollow.
12. Delete: right-click → Delete → confirm → the hook disappears from the tree and from disk (verify with `cat ~/.frida-toolkit/profiles/<game>/<build>/plugins/hooks/storage.json`).
