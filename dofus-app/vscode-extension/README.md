# Frida IL2CPP Toolkit — Core (v1)

VSCode extension for reverse engineering IL2CPP processes via Frida.
Provides a profile-per-build system that persists labels (renamed classes,
methods, fields), bookmarks, and notes — with automatic migration when
the game updates.

## Features (v1 Core)

- **Process Explorer** — tree view of assemblies → namespaces → classes
  with rename live + bookmarks + notes
- **Profile system** — per-`(game, build-id)` profile under
  `~/.frida-toolkit/profiles/`
- **Auto-migration** — fingerprint-matching labels across builds, with
  Migrations panel for review of ambiguous cases
- **Universal search** — Quick Pick over obf names + labels
- **Class detail webview** — fields, methods, parents, with action buttons
- **Internal Plugin API** — `CoreApi` consumed by future plugins (Hooks,
  Network, Deobfusc, Scripts) shipping in v1.1+

## Out of scope (v1)

- Hook management UI (v1.1)
- Network sniffer / Protobuf decoder (v1.2)
- Auto-deobfuscation engine (v1.3)
- Scripts / automation (v1.4)
- Tags + color coding
- Plugins as separate VSCode extensions (planned for v2)

## Getting started

1. Run a Frida agent on the target process. The agent must expose the
   HTTP RPC at `localhost:3001/api/call`. The companion agent in
   `src/rpc-agent/` works.
2. Open `dofus-app/vscode-extension/` in VSCode.
3. Run `npm install && npm run compile`.
4. Press **F5** to launch the Extension Development Host.
5. The ⚡ icon appears in the activity bar of the new window.

## Settings

| Setting | Default | Description |
|---|---|---|
| `fridaToolkit.rpcEndpoint` | `http://localhost:3001/api/call` | Frida RPC URL |
| `fridaToolkit.profileRoot` | `~/.frida-toolkit/profiles` | Profile storage path |
| `fridaToolkit.gameNameOverride` | `""` | Override the auto-derived game name |
| `fridaToolkit.showObfNamesAlongside` | `false` | Show obf names alongside labels |
| `fridaToolkit.search.maxResults` | `100` | Quick Pick result cap |
| `fridaToolkit.migration.autoMigrateThreshold` | `0.95` | Auto-migrate score threshold |

## Architecture

Single VSCode extension monolith for v1. Internal modules under `src/core/`:

```
src/core/
├── types.ts            # Shared types
├── rpc.ts              # HTTP RPC client
├── detect.ts           # Build-id auto-detection cascade
├── labels.ts           # Label store (CRUD + undo/redo + persistence)
├── annotations.ts      # Bookmarks + notes
├── migrations.ts       # Cross-build matching engine
├── profile.ts          # Profile manager
├── api.ts              # CoreApi exposed to plugins
├── status-bar.ts       # Connection status
├── explorer.ts         # Tree providers (Explorer, Bookmarks, Migrations)
├── search.ts           # Universal search
├── commands.ts         # Command palette wiring
└── webviews/
    ├── class-detail.ts
    └── migration-review.ts
```

Tests via vitest in `test/`. Run with `npm test`.

## Plugin development (v1.1+)

Future plugins live in `src/plugins/<plugin-id>/`. They import:

```typescript
import { getCoreApi } from "../../extension";
const api = getCoreApi();
if (!api) { /* not yet activated */ }
```

The `CoreApi` exposes labels CRUD, profile state, RPC passthrough, UI
helpers, and per-plugin storage.

## Spec + plan

- [Design spec](../../docs/superpowers/specs/2026-04-30-frida-il2cpp-toolkit-core-design.md)
- [Implementation plan](../../docs/superpowers/plans/2026-04-30-frida-il2cpp-toolkit-core.md)
- [Smoke test checklist](./SMOKE-TEST.md)
