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
