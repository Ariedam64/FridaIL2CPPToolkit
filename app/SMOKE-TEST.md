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
12. **Auto-revert** — install a hook on a method that doesn't exist (manual: type a bogus name in the Hooks "Add hook" prompt). Wrapper auto-reverts on lookup error; a warning toast appears in the browser console.

## Persistence

```bash
cat ~/.frida-toolkit/profiles/<game>/<buildId>/plugins/hooks/storage.json
```

The hooks defined via the UI should be in there with the right `className` (full namespace-qualified, not short obf).
