# Plugin: Hooks

First-party plugin shipped with the Toolkit Core. Adds Frida method hooks
managed via a tree sidebar, with a webview log panel for live observation.

## Architecture

Agent-side: `src/rpc-agent/hooks.ts` (managed lifecycle: installHook /
revertHook / listInstalledHooks / clearAllHooks). Each hit emits a
`HookEvent` via Frida `send()`.

Plugin-side: this folder. Persists hook definitions per-profile via
`coreApi.storage("hooks")` (the DiskPluginStorage from the Toolkit Core).
Hooks are saved DISARMED — re-arming on attach is explicit (no
auto-arm, see spec for rationale).

## Templates (v1.1)

| Template | What it does |
|----------|--------------|
| `log`         | Logs args + retval per call |
| `log-stack`   | Same as `log` plus an IL2CPP backtrace on the first N=5 hits |
| `noop`        | Replaces the method with a return-undefined stub |
| `force-return`| Replaces the method's return value with a constant |

## Modes

This plugin requires direct Frida mode (`fridaToolkit.useDirectMode = true`).
HTTP mode lacks the agent → host event channel.

## Files

- `index.ts` — `activateHooksPlugin(coreApi, ctx)`
- `hook-store.ts` — CRUD + persistence + RPC orchestration
- `hook-event-bus.ts` — `script.message` filter + ring buffer
- `hooks-tree.ts` — TreeDataProvider
- `commands.ts` — VSCode command handlers
- `webviews/hook-log.ts` — Stream + Summary webview
- `types.ts` — type mirror of `src/rpc-agent/hook-types.ts`
- `hook-spec-validation.ts` — pure validation

## Spec

`docs/superpowers/specs/2026-05-05-frida-il2cpp-toolkit-plugin-hooks-design.md`
