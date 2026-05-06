# Frida IL2CPP Toolkit — Localhost Web App (v2.0) — Design Spec

> Migration complète de l'extension VSCode vers une app web locale.
> Frontend Vanilla TS rendu directement dans le browser (lightweight DOM,
> pas de TreeDataProvider VSCode), backend Node.js qui héberge la session
> Frida et expose l'API au frontend. Style "IDE Pro" en palette indigo.

**Date** : 2026-05-06
**Branche cible** : nouvelle branche `localhost-v2` (depuis `toolkit-core-v1`)
**Auteur** : brainstormé avec l'utilisateur (via UI/UX Pro Max + visual companion)
**Remplace** : `dofus-app/vscode-extension/` (sera supprimé)

---

## TL;DR

Un serveur Node.js (Express + WebSocket) sur `localhost:3001` qui :

1. Embarque la session Frida via `frida-node` (réutilise `FridaDirectClient`)
2. Sert le frontend Vanilla TS (Vite-built) au navigateur
3. Expose `/api/call` (HTTP) pour les RPCs synchrones (`listAssembliesInfo`, `dumpClassAsString`, `installHook`, etc.)
4. Pousse les events `send()` Frida au frontend via WebSocket `/events`
5. Réutilise tout l'écosystème existant : profiles per-build, labels store, annotations, plugins/hooks (HookStore + persist disque)

Le **frontend** est une SPA layout "IDE Pro" en palette indigo (#6366F1) :
- Sidebar étroite icons (Process Explorer / Hooks / Bookmarks / Migrations / Settings / Profile)
- Sidebar contextuelle (selon icon actif — par défaut Process Explorer)
- Main area avec tabs multi-classes (chaque tab = une classe ouverte)
- Right panel Hook Log avec tabs Stream / Summary / Hooks
- Status bar bas
- Command palette ⌘K pour navigation rapide

Persistance disque inchangée : `~/.frida-toolkit/profiles/<game>/<build>/...`. Les profiles, labels, annotations, hooks survivent à la migration.

**L'extension VSCode est entièrement supprimée**.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| 0 | Pourquoi migrer | VSCode TreeDataProvider lent à scale (13k+ classes), API VSCode contraignante, dev cycle plus lent (F5 / reload window) |
| Q1 | Layout général | **IDE Pro** — sidebar étroite + Process Explorer panel + main avec tabs + right panel Hook Log + status bar |
| Q2 | Style direction | **Dark OLED** comme base (JetBrains Mono + IBM Plex Sans, navy slate) |
| Q3 | Palette colors | **Indigo (#6366F1)** au lieu du bleu VSCode, dégradés sur CTAs et active states |
| Q4 | Migration extension VSCode | **Drop complet** (option a) — l'extension est supprimée |

---

## Goals / Non-goals

### Goals

- **Performance native browser** — rendu DOM léger, virtualisation possible, dev tools du navigateur, refresh = rebuild instantané
- **Full feature parity** avec l'extension v1 actuelle : Process Explorer, Class Detail, Bookmarks, Migrations, Hooks plugin
- **Réutilisation maximale** du code existant : `src/lib/`, `src/rpc-agent/`, et les modules vscode-free de l'extension (profile, labels, annotations, hooks core, etc.)
- **API découplée** entre frontend et backend — les modules métier ne dépendent ni de Vue/React ni d'Express
- **Single-process** — un seul Node.js qui sert à la fois l'API HTTP, le flux WS et le frontend statique. Pas de gestion multi-process pour l'utilisateur.
- **Workflow fluide** — `npm run dev` lance le tout (backend + Vite HMR), `npm run build` produit le bundle prêt à servir
- **Style "IDE Pro" indigo** — JetBrains Mono / IBM Plex Sans, navy slate background, accent indigo, dégradés subtils sur CTAs et selections

### Non-goals

- **Pas de framework lourd** (React/Vue/Svelte/Angular) — Vanilla TS + Vite suffit. La complexité ne justifie pas un framework.
- **Pas de PWA / installable app** — on reste sur localhost, pas d'usage offline.
- **Pas de support multi-utilisateur ou collaboration** — un user par session, pas de partage cloud.
- **Pas d'auth / TLS** — localhost seulement, bind 127.0.0.1.
- **Pas de mode HTTP-only Frida** (l'ancien `useDirectMode = false`) — on est toujours en mode direct via frida-node embarqué dans le backend.
- **Pas de coexistence avec l'extension VSCode** — drop complet.

---

## Architecture

### Vue d'ensemble

```
┌──────────────────────────── Browser (localhost:3001) ────────────────────────┐
│                                                                              │
│  Frontend SPA (Vanilla TS, Vite-built)                                       │
│   • Pages : Process Explorer, Class Detail, Hooks, Bookmarks, Migrations     │
│   • State : in-memory + IndexedDB cache pour le tree (perf cold-start)       │
│   • Theme : dark OLED + indigo accents (CSS vars + Google Fonts)             │
│                                                                              │
│  HTTP /api/call ──┐                                       ┌── WS /events     │
└───────────────────┼───────────────────────────────────────┼──────────────────┘
                    ▼                                       ▼
┌─────────────────────── Node.js backend (single process) ─────────────────────┐
│                                                                              │
│  Express server                                                              │
│   • POST /api/call { method, args }  → forward to FridaDirectClient.call()   │
│   • GET  /api/profile                → current Profile + manifest            │
│   • GET  /api/state                  → labels, annotations, hooks list       │
│   • POST /api/labels/:kind            → set/remove labels                     │
│   • POST /api/annotations/...         → bookmarks + notes                     │
│   • POST /api/hooks/...               → install / revert / list / clear      │
│   • Static : /assets/* (Vite bundle output)                                  │
│   • SPA fallback : * → index.html                                            │
│                                                                              │
│  WebSocket /events                                                           │
│   • Client subscribes once at boot                                           │
│   • Server pipes Frida send() payloads + label/annotation/hook change events │
│                                                                              │
│  Reused modules (from vscode-extension/src/core/*) :                         │
│   ProfileManager, LabelStore, AnnotationStore, HookStore, HookEventBus,      │
│   DiskPluginStorage, paths, types, detect, migrations                        │
│                                                                              │
│  FridaDirectClient — frida-node embedded, talks to the agent                 │
└────────────────────────────────────────────────────────────────────────────────┘
                                     ↕ Frida-node ipc
┌─────────────── Frida agent (src/rpc-agent/, unchanged) ─────────────────────┐
│  RPC methods + send() event stream — no agent-side changes for v2           │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Découplage net

- **Frontend** ne sait rien de Frida. Il appelle des routes HTTP/WS sur son serveur local et reçoit des données déjà typées.
- **Backend** ne sait rien du HTML. Il expose une API REST + WS, sans logique d'affichage.
- **Modules métier** (profile / labels / hooks / etc.) sont vscode-free (déjà le cas dans v1) — réutilisables tels quels par le backend.
- **Agent Frida** reste identique — la migration v2 ne touche pas `src/rpc-agent/`.

### Tech stack

| Côté | Stack |
|------|-------|
| Backend | Node.js 20+, TypeScript, Express, `ws` (WebSocket), `frida-node` |
| Frontend | Vanilla TypeScript, Vite (dev + build), CSS custom (vars + Google Fonts JetBrains Mono / IBM Plex Sans) |
| Persistence | Filesystem JSON (`~/.frida-toolkit/profiles/<game>/<build>/...`), inchangé |
| Tests | vitest sur les modules métier réutilisés (déjà 89/89 verts) + nouveaux tests pour les routes Express |
| Build agent | inchangé — `frida-compile src/rpc-agent/index.ts` |

---

## File layout (nouvelle structure)

```
frida-toolkit/
├── src/                                # Frida agent (inchangé)
│   ├── lib/
│   └── rpc-agent/
├── app/                                # NOUVEAU — backend + frontend
│   ├── package.json                    # deps : express, ws, frida-node, vite, etc.
│   ├── tsconfig.backend.json
│   ├── tsconfig.frontend.json
│   ├── vite.config.ts
│   ├── backend/
│   │   ├── server.ts                   # Express + WS bootstrap
│   │   ├── routes/
│   │   │   ├── api-call.ts             # POST /api/call
│   │   │   ├── profile.ts              # GET /api/profile
│   │   │   ├── labels.ts               # POST /api/labels/...
│   │   │   ├── annotations.ts          # POST /api/annotations/...
│   │   │   └── hooks.ts                # POST /api/hooks/...
│   │   ├── ws-bridge.ts                # WS /events broadcaster
│   │   ├── frida-client.ts             # FridaDirectClient wrapper (reused from v1)
│   │   └── core/                       # symlink ou copy de l'ancien `core/` :
│   │       ├── profile.ts              # ProfileManager (reused)
│   │       ├── labels.ts               # LabelStore (reused)
│   │       ├── annotations.ts          # AnnotationStore (reused)
│   │       ├── plugin-storage.ts       # DiskPluginStorage (reused)
│   │       ├── paths.ts                # expandHome (reused)
│   │       ├── types.ts                # (reused)
│   │       ├── detect.ts               # build-id detection (reused)
│   │       ├── migrations.ts           # matchFingerprints (reused)
│   │       └── hooks/                  # plugin Hooks core (reused)
│   │           ├── hook-store.ts
│   │           ├── hook-event-bus.ts
│   │           ├── hook-spec-validation.ts
│   │           └── types.ts
│   ├── frontend/
│   │   ├── index.html
│   │   ├── main.ts                     # entry point
│   │   ├── styles/
│   │   │   ├── theme.css               # CSS vars (indigo palette, dark OLED)
│   │   │   └── fonts.css               # @import Google Fonts
│   │   ├── core/
│   │   │   ├── api.ts                  # fetch wrapper for /api/call etc.
│   │   │   ├── ws.ts                   # WebSocket client + event dispatch
│   │   │   ├── store.ts                # global app state (current profile, labels, hooks…)
│   │   │   ├── router.ts               # hash-based router
│   │   │   └── tabs.ts                 # multi-tab manager
│   │   ├── components/                 # vanilla TS components (no JSX)
│   │   │   ├── nav-icons.ts            # left narrow nav
│   │   │   ├── process-explorer.ts     # Process Explorer panel (virtualized)
│   │   │   ├── class-detail.ts         # Class Detail (parsed dump + Hook buttons)
│   │   │   ├── hook-log.ts             # right-panel Stream / Summary / Hooks tabs
│   │   │   ├── command-palette.ts      # ⌘K
│   │   │   ├── status-bar.ts
│   │   │   ├── breadcrumb.ts
│   │   │   └── …
│   │   └── pages/
│   │       ├── explorer.ts             # default — Process Explorer + Class Detail
│   │       ├── hooks.ts                # full Hook management view
│   │       ├── bookmarks.ts
│   │       └── migrations.ts
│   └── public/                         # static assets (icons, etc.)
│
├── docs/superpowers/specs/             # spec files (this one)
├── docs/superpowers/plans/             # implementation plan (next step)
├── package.json                        # top-level scripts (dev, build, dev:agent, …)
└── README.md
```

**Suppression** : `dofus-app/vscode-extension/` est supprimé en bloc dans le commit final de la migration.

---

## Visual design (style guide)

Référence visuelle : `docs/superpowers/specs/assets/2026-05-06-hybrid-mock.html` (à committer comme artefact). Le mockup sur visual companion est validé.

### Tokens

```css
:root {
  /* Backgrounds */
  --bg-base:        #08080c;   /* page bg */
  --bg-panel:       #0a0a0f;   /* sidebars */
  --bg-elevated:    #0d0d12;   /* main content area */
  --bg-tile:        #14141c;   /* cards, hover state */
  --bg-tile-hover:  #1a1a24;

  /* Borders / dividers */
  --border:         #18181f;
  --border-strong:  #1f1f2a;

  /* Text */
  --text-primary:   #f0f6fc;
  --text-secondary: #e6edf3;
  --text-muted:     #9ca3af;
  --text-faint:     #6b7280;

  /* Indigo accent */
  --indigo:         #6366f1;
  --indigo-hover:   #818cf8;
  --indigo-deep:    #4f46e5;
  --indigo-bg:      rgba(99, 102, 241, 0.15);
  --indigo-bg-soft: rgba(99, 102, 241, 0.04);
  --indigo-border:  rgba(99, 102, 241, 0.4);
  --indigo-glow:    0 4px 12px rgba(99, 102, 241, 0.3);

  /* Semantic */
  --success:        #22c55e;
  --warning:        #f59e0b;
  --danger:         #ef4444;
  --method:         #a78bfa;   /* method tag */
  --field:          #22c55e;   /* field tag */

  /* Code highlight */
  --syntax-keyword: #ff7b72;   /* method/field keyword */
  --syntax-type:    #79c0ff;
  --syntax-name:    #f0f6fc;
  --syntax-string:  #a5d6ff;
  --syntax-return:  #7ee787;

  /* Typography */
  --font-ui:        'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-code:      'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  /* Sizes */
  --radius-sm:      4px;
  --radius:         6px;
  --radius-lg:      8px;
  --radius-xl:      12px;
  --transition:     150ms ease;
  --transition-fast: 100ms ease;
}
```

### Composants visuels-clés (spécifiés dans le mockup hybride)

- **Nav-icons** (left, 48px wide) : icons 36×36, active state = `linear-gradient(135deg, var(--indigo), var(--indigo-deep))` + `box-shadow: var(--indigo-glow)`. Badge count rouge en top-right pour les notifications.
- **Tree node** : padding 4×8, border-radius 6px, hover = `var(--bg-tile)`, **selected** = `linear-gradient(90deg, rgba(99,102,241,0.18), rgba(99,102,241,0.04))` + `border-left: 2px solid var(--indigo)`.
- **Filter pill** : input dans une pill avec icône search à gauche et kbd indicator à droite (`/`). Border devient indigo au focus.
- **Tabs** (main area) : `border-bottom: 2px solid var(--indigo)` quand active, gradient sublime de fond.
- **Member row** : monospace, `kind-tag` (METHOD violet / FIELD vert), name en `--text-primary`, type en `--syntax-type`, actions à droite cachées sauf au hover. **Hooked** state = gradient indigo + border indigo.
- **Right tabs** : pill-style avec count-pill JetBrains Mono. Live-dot pulsant sur Stream tab quand events arrivent.
- **Status bar** : 26px high, status-dot glow vert quand connecté.
- **Command palette ⌘K** : centered modal, search input en haut + résultats catégorisés (classes, methods, commands).

---

## Data flow

### HTTP RPC flow (synchronous)

```
Frontend                        Backend                    Frida agent
   │                              │                            │
   │ POST /api/call               │                            │
   │ {method:"listAssembliesInfo"}│                            │
   ├─────────────────────────────▶│                            │
   │                              │ FridaDirectClient.call()   │
   │                              ├───────────────────────────▶│
   │                              │                            │
   │                              │◀───────────────────────────┤
   │ 200 OK { result: [...] }     │                            │
   │◀─────────────────────────────┤                            │
```

### WebSocket flow (events)

```
Frontend                        Backend                    Frida agent
   │ WS /events                   │                            │
   ├─────────────────────────────▶│                            │
   │                              │ on script.message()        │
   │                              │◀───────────────────────────┤
   │                              │   { type:"hook-event"…}   │
   │ {type:"hook-event"…}         │                            │
   │◀─────────────────────────────┤                            │
```

### Local state mutations (labels, hooks)

```
Frontend                        Backend                       Disk
   │ POST /api/labels/class       │                            │
   │ {className,label}            │                            │
   ├─────────────────────────────▶│ LabelStore.set()           │
   │                              ├───────────────────────────▶│
   │                              │ scheduleFlush(500)         │
   │ 200 OK                       │                            │
   │◀─────────────────────────────┤                            │
   │                              │                            │
   │ WS event: label-change       │ broadcast to all clients   │
   │◀─────────────────────────────┤                            │
```

### Bootstrap sequence

1. User runs `npm run dev` (or `npm start` for prod build).
2. Backend starts on `localhost:3001`, immediately tries `frida-node` attach (if a process is configured) OR shows "no process attached" until user picks one via the frontend.
3. Frontend served at `/` redirects to `/explorer` by default.
4. Frontend opens WS `/events`, calls `/api/profile` to know if a profile is attached.
5. If attached → fetches the assemblies index via `/api/call listAssembliesInfo`.
6. If not → shows the "Pick a process" UI.
7. User actions (click class, install hook, rename, etc.) → HTTP call → backend mutation → broadcast event → frontend re-renders.

---

## API surface

### HTTP routes

| Route | Body | Returns |
|-------|------|---------|
| `POST /api/call` | `{ method: string, args?: unknown[] }` | `{ result: unknown }` or `{ error: string }` |
| `GET  /api/profile` | — | `Profile \| null` (manifest + paths) |
| `POST /api/profile/attach` | `{ pid: number }` | `Profile` |
| `POST /api/profile/detach` | — | `{ ok: true }` |
| `GET  /api/labels` | — | `LabelsFileV1` |
| `POST /api/labels/:kind` | `{ key, label }` or `{ key, remove: true }` | `{ ok: true }` |
| `GET  /api/annotations` | — | `{ bookmarks, notes }` |
| `POST /api/annotations/bookmark` | `{ key, action: "toggle" }` | `{ ok: true }` |
| `POST /api/annotations/note` | `{ key, markdown }` or `{ key, remove: true }` | `{ ok: true }` |
| `GET  /api/hooks` | — | `StoredHook[]` |
| `POST /api/hooks/add` | `HookSpec` | `StoredHook` |
| `POST /api/hooks/install` | `{ id: string }` | `{ hookId: string }` |
| `POST /api/hooks/uninstall` | `{ id: string }` | `{ ok: true }` |
| `POST /api/hooks/update` | `{ id, spec }` | `{ ok: true }` |
| `POST /api/hooks/remove` | `{ id }` | `{ ok: true }` |
| `POST /api/hooks/clear-all` | — | `{ count }` |
| `GET  /api/migrations` | — | `MigrationResult` |
| `POST /api/migrations/accept` | `{ oldObf, newObf }` | `{ ok: true }` |
| `POST /api/migrations/reject` | `{ oldObf }` | `{ ok: true }` |

### WebSocket events (server → client)

| Type | Payload |
|------|---------|
| `hook-event` | `{ hookId, ts, self, args, retval, error?, stackFrames? }` |
| `hook-auto-revert` | `{ hookId, ts, reason, detail? }` |
| `label-change` | `{ key, oldLabel, newLabel }` |
| `annotation-change` | `{ key, kind: "bookmark" \| "note", action }` |
| `hook-store-change` | (no payload — client refetches) |
| `profile-attached` | `Profile` |
| `profile-detached` | `{}` |
| `agent-message` | unrelated `send()` payloads (forwarded raw) |

---

## Persistence (unchanged)

`~/.frida-toolkit/profiles/<game>/<build>/`
- `manifest.json` — same schema
- `labels.json` — same schema
- `annotations.json` — same schema
- `fingerprints.json` — same schema
- `migrations.json` — same schema
- `plugins/hooks/storage.json` — same schema (`{ hooks: StoredHook[] }`)

The new backend reads/writes the exact same files. **No migration needed** — existing profiles work as-is.

---

## Migration from VSCode extension

### Strategy

**Branche neuve `localhost-v2` depuis `toolkit-core-v1`**. La nouvelle app est construite à côté de l'ancienne pendant le dev. Au moment du merge final :

1. Le code `dofus-app/vscode-extension/` est supprimé en un commit dédié.
2. Le code `app/` (nouveau) prend le relais.
3. Le `package.json` racine ajoute les scripts `dev` / `build` pointant sur `app/`.
4. Les modules métier réutilisés sont **copiés** (pas symliés ou subtreed) depuis l'ancien `dofus-app/vscode-extension/src/core/` vers `app/backend/core/`. Les imports VSCode sont retirés (déjà absents pour la majorité).
5. README mis à jour.

### Modules réutilisables (≥80%)

Tous ces fichiers sont déjà vscode-free et passent en l'état :

```
dofus-app/vscode-extension/src/core/labels.ts          → app/backend/core/labels.ts
dofus-app/vscode-extension/src/core/annotations.ts     → app/backend/core/annotations.ts
dofus-app/vscode-extension/src/core/profile.ts         → app/backend/core/profile.ts
dofus-app/vscode-extension/src/core/paths.ts           → app/backend/core/paths.ts
dofus-app/vscode-extension/src/core/plugin-storage.ts  → app/backend/core/plugin-storage.ts
dofus-app/vscode-extension/src/core/types.ts           → app/backend/core/types.ts
dofus-app/vscode-extension/src/core/detect.ts          → app/backend/core/detect.ts
dofus-app/vscode-extension/src/core/migrations.ts      → app/backend/core/migrations.ts
dofus-app/vscode-extension/src/core/search-filters.ts  → app/backend/core/search-filters.ts
dofus-app/vscode-extension/src/plugins/hooks/hook-store.ts          → app/backend/core/hooks/hook-store.ts
dofus-app/vscode-extension/src/plugins/hooks/hook-spec-validation.ts → app/backend/core/hooks/hook-spec-validation.ts
dofus-app/vscode-extension/src/plugins/hooks/hook-event-bus.ts      → app/backend/core/hooks/hook-event-bus.ts
dofus-app/vscode-extension/src/plugins/hooks/types.ts               → app/backend/core/hooks/types.ts
```

Les tests vitest existants (89/89) sont copiés et tournent inchangés.

### À refaire from scratch

```
extension.ts                          → app/backend/server.ts
core/commands.ts                      → app/backend/routes/* (HTTP routes)
core/explorer.ts (TreeDataProvider)   → app/frontend/components/process-explorer.ts (DOM-based)
core/status-bar.ts                    → app/frontend/components/status-bar.ts
core/webviews/class-detail.ts         → app/frontend/components/class-detail.ts (HTML déjà 90% prêt)
core/webviews/process-explorer.ts     → app/frontend/components/process-explorer.ts (HTML déjà prêt)
core/webviews/hook-log.ts             → app/frontend/components/hook-log.ts (HTML déjà prêt)
core/webviews/migration-review.ts     → app/frontend/components/migration-review.ts
plugins/hooks/index.ts                → app/backend/routes/hooks.ts + app/frontend/pages/hooks.ts
plugins/hooks/hooks-tree.ts           → app/frontend/components/hooks-list.ts (DOM-based)
plugins/hooks/commands.ts             → app/backend/routes/hooks.ts (HTTP) + app/frontend/components/hook-actions.ts
package.json (extension manifest)     → app/package.json (deps Express, ws, vite, etc.)
```

---

## Risks / mitigations

| Risque | Probabilité | Mitigation |
|--------|-------------|------------|
| Régression d'une feature lors de la migration | Moyenne | Tests vitest existants restent verts. Smoke-test manuel checklist (recopie SMOKE-TEST.md) avant le drop final. |
| Frida-node moins bien supporté hors VSCode | Faible | C'est une lib Node standard, pas spécifique à VSCode. Même API utilisée. |
| Performance frontend < extension | Très faible | Browser DOM > VSCode TreeDataProvider sur grands volumes (la motivation initiale). |
| Sécurité localhost — port 3001 ouvert | Faible | Bind sur `127.0.0.1` uniquement, pas accessible depuis le réseau. Rappel dans le README. |
| Workflow degraded — perte du F5 VSCode | Moyenne | Compensé par Vite HMR (changement TS visible dans le browser en <500ms). |
| Hot-reload du frontend casse l'état (selected class, hook log) | Moyenne | Persiste l'état UI critique dans `sessionStorage` (active tab, current class, log buffer). |

---

## Phases / time estimate

Ordre logique. Chaque phase = 1 commit minimum, build vert + smoke-test si applicable.

| Phase | Description | Estimation |
|-------|-------------|-----------|
| 1 | **Backend skeleton** : `app/` créé, Express + ws bootstrap, route `/api/call` qui forward vers FridaDirectClient | 0.75 j |
| 2 | **Module reuse** : copier les modules vscode-free dans `app/backend/core/`, vérifier les tests vitest passent | 0.5 j |
| 3 | **HTTP routes** : profile, labels, annotations, hooks (toutes les routes listées dans la section API) | 0.5 j |
| 4 | **WS bridge** : flux Frida `send()` + change events broadcastés au client | 0.25 j |
| 5 | **Frontend setup** : Vite config, theme.css (tokens), fonts.css, layout shell (nav-icons + sidebar + main + right-panel + statusbar) | 0.75 j |
| 6 | **Process Explorer** : porter le HTML existant, virtualisation, on-demand expansion, filter | 1 j |
| 7 | **Class Detail** : porter le HTML existant, Hook + Trace + Copy buttons, search filter, parse markdown | 0.75 j |
| 8 | **Hook Log** : Stream + Summary + Hooks tabs, ring buffer, filter, export | 0.75 j |
| 9 | **Bookmarks + Migrations** pages | 0.5 j |
| 10 | **Command palette ⌘K** : search classes + commands, kbd shortcuts | 0.5 j |
| 11 | **Status bar + breadcrumb + tabs manager** | 0.25 j |
| 12 | **Smoke test pass + bug fix** : SMOKE-TEST.md adapté, run-through checklist | 0.5 j |
| 13 | **Drop VSCode extension** : commit qui supprime `dofus-app/vscode-extension/`, README mis à jour | 0.25 j |

**Total : ~7 jours** (un peu plus que mes 4-5 j initiaux — j'avais sous-estimé la phase frontend).

---

## Open questions (à trancher pendant l'impl)

1. **Multi-tab persistance** — Si l'utilisateur ferme et rouvre l'app, on restaure les tabs ouvertes ? Stockage dans `sessionStorage` ou fichier disque ?
2. **Command palette scope** — Just classes/methods/fields, ou aussi commandes (Open hooks, Toggle bookmark…) ?
3. **Hot-reload frontend** — En dev avec Vite HMR, comment gérer les `WS` ouverts ? Probablement un reconnect au reload est OK.

---

## Référence visuelle

Le mockup HTML validé (option "hybride") :

`f:\FridaIL2CPPToolkit\.superpowers\brainstorm\1799-1778083444\content\04-hybrid.html`

Sera commité à `docs/superpowers/specs/assets/2026-05-06-hybrid-mock.html` comme artefact de référence pour le développeur.
