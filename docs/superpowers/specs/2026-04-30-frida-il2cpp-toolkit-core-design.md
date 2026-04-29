# Frida IL2CPP Toolkit — Core (v1) — Design Spec

> Refonte propre du toolkit en VSCode extension générique pour reverse engineering de processes IL2CPP. Cette spec couvre uniquement le **Core** (foundation). Les plugins (Hooks, Network, Deobfusc, Scripts) auront chacun leur spec séparée.

**Date** : 2026-04-30
**Auteur** : brainstormé avec l'utilisateur

## TL;DR

Le Core est une VSCode extension qui :

1. Se connecte au Frida RPC agent existant (`localhost:3001/api/call`)
2. Détecte automatiquement le process attaché (Unity build-guid ou hash metadata)
3. Charge un **profil** versionné par build qui persiste les **labels** (renames classes/méthodes/fields), bookmarks, et notes
4. Expose un **Process Explorer** dans le sidebar avec rename live + search universelle
5. Migre automatiquement les labels au premier attach d'un nouveau build, avec diff utilisateur dans un panel dédié
6. Fournit une **API interne minimale** consommée par les plugins futurs (Hooks, Network, etc.)

Le tout en **une seule extension** pour le v1 (monolithe avec frontières internes propres). Refactor en extensions séparées au v2 quand la surface API sera stabilisée par l'usage.

## Goals / Non-goals

### Goals

- Toolkit utilisable pour **n'importe quel process IL2CPP** (Unity ou non), pas spécifique à Dofus
- **Persistance robuste** : tout ce que l'utilisateur nomme/annote survit aux restarts et aux mises à jour du jeu
- **UX simple** : interface familière (VSCode), peu de chrome, fonctions essentielles seulement
- **Extensibilité** : architecture qui accueillera les plugins Hooks/Network/Deobfusc/Scripts sans refonte
- **Migration MAJ** : à l'attache d'un nouveau build du même jeu, les labels existants sont auto-migrés via fingerprint matching, avec diff visible

### Non-goals (v1)

- Pas de plugins externes (= extensions VSCode séparées). Tout en un repo, refactoré au v2.
- Pas de Tags ni Color coding (reportés à v1.1+ si besoin émerge)
- Pas de Hook management (plugin dédié)
- Pas de Network sniffer (plugin dédié)
- Pas de Deobfusc engine auto (plugin dédié)
- Pas de système de Scripts/Automation (plugin dédié)
- Pas de support pour profils multi-utilisateurs ou collaboration

## Architecture

### Stack technique

- **VSCode extension** (TypeScript, Node 20+, VSCode 1.85+)
- Communication : HTTP `localhost:<port>/api/call` vers l'agent Frida-il2cpp-bridge existant
- Persistance : fichiers JSON sous `~/.frida-toolkit/profiles/<profile-id>/`
- Webviews custom pour les vues riches (détail classe, panel migrations)

### Vue d'ensemble

```
┌────────────────────────────────────────────────────────────────────┐
│  VSCode Extension : "frida-il2cpp-toolkit"                         │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  CORE (in extension/src/core/)                                │ │
│  │                                                               │ │
│  │  • profile.ts       — Profile manager (per build-version)     │ │
│  │  • labels.ts        — Label store (rename CRUD + events)      │ │
│  │  • annotations.ts   — Bookmarks + notes (per class/method/fld)│ │
│  │  • explorer.ts      — Process Explorer TreeDataProvider       │ │
│  │  • search.ts        — Universal search (Ctrl+P)               │ │
│  │  • migrations.ts    — Build-to-build migration engine + UI    │ │
│  │  • status-bar.ts    — Connection state + profile info         │ │
│  │  • detect.ts        — Build-version auto-detection            │ │
│  │  • rpc.ts           — Frida RPC client wrapper                │ │
│  │  • api.ts           — Internal API exposed to plugins         │ │
│  │  • commands.ts      — Command palette registrations           │ │
│  │                                                               │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                              ▲                                     │
│                              │ uses CoreApi                        │
│                              │                                     │
│  ┌───────────────────────────┴──────────────────────────────────┐ │
│  │  PLUGINS (in extension/src/plugins/, future)                  │ │
│  │  • hooks/      ← v1.1 spec                                    │ │
│  │  • network/    ← v1.2 spec                                    │ │
│  │  • deobfusc/   ← v1.3 spec                                    │ │
│  │  • scripts/    ← v1.4 spec                                    │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
```

### File layout (extension repo)

```
frida-toolkit/
├── package.json              # extension manifest
├── tsconfig.json
├── src/
│   ├── extension.ts          # activate() / deactivate()
│   ├── core/
│   │   ├── profile.ts
│   │   ├── labels.ts
│   │   ├── annotations.ts
│   │   ├── explorer.ts
│   │   ├── search.ts
│   │   ├── migrations.ts
│   │   ├── status-bar.ts
│   │   ├── detect.ts
│   │   ├── rpc.ts
│   │   ├── api.ts
│   │   ├── commands.ts
│   │   └── webviews/
│   │       ├── class-detail.ts
│   │       └── migration-review.ts
│   └── plugins/              # empty pour v1, structuré pour accueil
│       └── README.md
├── test/
│   └── (unit tests for pure modules — labels, migrations algo, etc.)
└── docs/
    └── plugin-api.md         # auto-doc de api.ts pour les futurs plugins
```

### Data flow

```
User attache Frida à dofus.exe → agent expose RPC sur :3001
        │
        ▼
extension activate()
        │
        ├──▶ rpc.ts ping → confirms connectivity
        │
        ├──▶ detect.ts identifies the process:
        │     1. read assembly list
        │     2. try Unity boot.config build-guid
        │     3. fallback: hash de global-metadata.dat
        │     4. fallback final: hash du binaire principal
        │
        ├──▶ profile.ts loads or creates profil:
        │     ~/.frida-toolkit/profiles/<game-name>/<build-id>/
        │
        ├──▶ if new build with previous version → migrations.ts auto-derives,
        │     stores diff in profile, fires "migration-ready" event
        │
        ├──▶ labels.ts loads labels.json, exposes get/set + events
        │
        ├──▶ explorer.ts registers TreeDataProvider, populates from RPC
        │
        ├──▶ status-bar.ts shows connection + profile info
        │
        └──▶ api.ts is now ready for plugins (none in v1)
```

## Components

### 1. Profile system

**Identité d'un profil** : `(game-name, build-id)` paire.

- `game-name` : dérivé du nom du process (ex: `dofus.exe` → `dofus`). User peut overrider via Settings.
- `build-id` : auto-détecté par cascade :
  1. Unity `boot.config` `build-guid=<hex>` → utilisé si Unity
  2. Hash SHA256 du `global-metadata.dat` → utilisé pour tout IL2CPP
  3. Hash SHA256 du binaire principal (`<game>.exe` / `GameAssembly.dll`) → fallback

**Stockage** : `~/.frida-toolkit/profiles/<game-name>/<build-id>/` (sous le home utilisateur, pas dans le repo).

```
~/.frida-toolkit/profiles/
├── dofus/
│   ├── 8fcf84277e7043a6.../  ← build courant
│   │   ├── manifest.json
│   │   ├── labels.json
│   │   ├── annotations.json
│   │   └── migrations.json
│   └── 7a3d52e1d6f8b2c9.../  ← build précédent
│       └── ...
└── unity-game-2/
    └── ...
```

**`manifest.json`** :
```json
{
  "schemaVersion": 1,
  "profileId": "dofus/8fcf84277e7043a6...",
  "gameName": "dofus",
  "buildId": "8fcf84277e7043a6...",
  "buildIdSource": "unity-boot-config",
  "attachedFirstAt": "2026-04-30T14:23:45Z",
  "attachedLastAt": "2026-04-30T18:12:09Z",
  "derivedFrom": "dofus/7a3d52e1d6f8b2c9...",
  "stats": {
    "totalLabels": 354,
    "totalBookmarks": 12,
    "totalNotes": 8
  }
}
```

**API** (interne) :

```typescript
class ProfileManager {
  current(): Profile | null;
  onChange: vscode.EventEmitter<Profile | null>;
  
  // Triggered automatically on extension activation
  detectAndLoad(): Promise<Profile>;
  
  // For tests + manual override
  loadProfile(profileId: string): Promise<Profile>;
  createProfile(gameName: string, buildId: string, derivedFrom?: string): Promise<Profile>;
}

interface Profile {
  manifest: ProfileManifest;
  labels: LabelStore;       // injected
  annotations: AnnotationStore;
  migrations: MigrationStore;
  rootPath: string;          // filesystem path
}
```

### 2. Label store

**Granularité** : class + method + field.

**Identité d'un label** :

```typescript
type LabelKey =
  | { kind: "class"; className: string }                         // obf class name
  | { kind: "method"; className: string; methodName: string }    // obf
  | { kind: "field"; className: string; fieldName: string };     // obf
```

`className`/`methodName`/`fieldName` sont les **noms obfusqués** dans le binaire actuel (donc spécifiques au build). Le label friendly est le nom à afficher.

**Format `labels.json`** :

```json
{
  "schemaVersion": 1,
  "classes": {
    "egq": { "label": "HaapiService", "createdAt": "...", "updatedAt": "..." }
  },
  "methods": {
    "egq.ywp": { "label": "ConsumeKardByCode", "createdAt": "...", "updatedAt": "..." }
  },
  "fields": {
    "egq.dwm": { "label": "_kardCache", "createdAt": "...", "updatedAt": "..." }
  }
}
```

**API** (interne, exposée via `CoreApi.labels`) :

```typescript
class LabelStore {
  get(key: LabelKey): string | null;
  set(key: LabelKey, friendly: string): void;
  remove(key: LabelKey): void;
  
  bulkImport(json: object): { imported: number; skipped: number };
  bulkExport(): object;
  
  onChange: vscode.EventEmitter<LabelChangeEvent>;
  
  // Helpers for display
  display(key: LabelKey): string;       // returns friendly if set, else obf
  isObfuscated(key: LabelKey): boolean; // heuristic: short lowercase
}

interface LabelChangeEvent {
  key: LabelKey;
  oldLabel: string | null;
  newLabel: string | null;
}
```

**Persistance** : auto-save sur chaque modif, debounce 500ms, écriture atomique via tempfile + rename.

**Undo/redo** : ring buffer de 50 derniers changements en mémoire. Commands `Frida: Undo rename` / `Redo rename`. Pas de persistance de l'historique.

### 3. Annotations (bookmarks + notes)

**Granularité** : même que labels (class + method + field).

**Format `annotations.json`** :

```json
{
  "schemaVersion": 1,
  "bookmarks": {
    "class:egq": { "createdAt": "..." },
    "method:eat.LoadMap": { "createdAt": "..." }
  },
  "notes": {
    "class:egq": { "markdown": "Service principal HAAPI...", "updatedAt": "..." }
  }
}
```

Les clés sont stringifiées (`<kind>:<class>` ou `<kind>:<class>.<member>`) pour faciliter le sérialisation JSON.

**API** :

```typescript
class AnnotationStore {
  // Bookmarks
  isBookmarked(key: LabelKey): boolean;
  toggleBookmark(key: LabelKey): void;
  listBookmarks(): LabelKey[];
  
  // Notes
  getNote(key: LabelKey): string | null;
  setNote(key: LabelKey, markdown: string): void;
  removeNote(key: LabelKey): void;
  listNoted(): LabelKey[];
  
  onChange: vscode.EventEmitter<AnnotationChangeEvent>;
}
```

### 4. Process Explorer

**Vue** : TreeDataProvider hiérarchique (assembly → namespace → class → members).

**Source de données** : RPC calls vers Frida (`listAssembliesInfo`, `listNamespaces`, `listClassesIn`). Lazy-loaded à l'expansion d'un node.

**Affichage des classes** :
- Si label défini → `<friendly-name>` (avec tooltip showing obf)
- Sinon → `<obf>` (e.g. `egq`)
- Toggle global "Show obf alongside labels" affiche `<friendly> [<obf>]`
- Bookmark icône ⭐ à gauche si bookmarké
- Icône note 📝 si la classe a une note
- Icône hook 🔧 si un hook actif (futur, set par le plugin Hooks)

**Actions par classe** (clic-droit) :
- Open detail webview (default au clic gauche)
- Rename (label inline ou input)
- Bookmark
- Add note
- Copy obf name
- Find references (placeholder pour quand le plugin Deobfusc fournira des XRefs)

**Actions par méthode** : pareil, scopé à `(class, method)`.

**Actions par field** : pareil.

### 5. Search universelle

Activée par `Ctrl+Shift+P` → typer `Frida: Search` ou via raccourci dédié `Ctrl+Shift+F` (configurable).

**Scope de recherche** :
- Noms obfusqués (class, method, field)
- Labels (friendly names)
- Namespaces
- RVAs (par exemple `0x16FD310`)

**Behavior** :
- Fuzzy match (subsequence) sur les strings
- Préfixe `:` pour filtrer le type :
  - `:class HaapiService` → uniquement classes
  - `:method ConsumeKard` → uniquement méthodes
  - `:rva 0x16` → recherche par RVA
- Résultats clickables → ouvrent la webview détail

**Implémentation** : indice en mémoire reconstruit à l'attache. Acceptable jusqu'à ~50k entries; au-delà, considérer un tri/filtre côté worker.

### 6. Migrations (build-to-build)

**Trigger** : à l'attache d'un nouveau build d'un game existant (build-id différent du dernier connu).

**Algorithme de matching** :

1. Pour chaque label dans le profil précédent, chercher la classe correspondante dans le build courant via :
   - **Token IL2CPP** (le plus fiable, stable pour classes inchangées)
   - **Fingerprint structurel** (parents + nombre de méthodes + signatures de méthodes + types de fields)
   - **Si plusieurs matches plausibles** → marqué comme "à review" avec confidence score

2. Output : `migrations.json` avec 3 catégories :
   - `auto`: migré silencieusement (token match exact OU fingerprint unique avec score ≥ 95%)
   - `review`: candidats avec score 60-95% → user décide
   - `lost`: aucun match → label "perdu" (probablement classe supprimée/refactorée)

**UI** :
- Toast à la fin de l'attache : "12 labels migrés, 3 à review. Voir Migrations →"
- Panel sidebar **"Migrations"** dédié : liste les 3 à review, le user clique → modal qui montre le candidat side-by-side avec l'ancien (parents, méthodes, fields) → user accepte ou rejette
- Les labels migrés auto sont aussi visibles (pour audit), mais comme une liste pliable "Auto-migrated (12)"

**Persistance** : le `migrations.json` reste dans le profil pour traçabilité. Pas écrasé : chaque attach append une entrée timestamped.

### 7. Layout (UI)

**Layout B** validé : sidebar dense + bottom panel.

**Activity bar** : nouvelle icône ⚡ "Frida Toolkit"

**Sidebar (sous icône ⚡)** :
- `Process Explorer` (toujours visible, principale)
- `Bookmarks` (toujours visible, sous Explorer)
- `Migrations` (visible quand un attach a eu lieu et il y a un diff)

**Bottom panel** : VSCode native panel avec tabs :
- `RPC Log` : logs des RPC calls (debug)
- `Output: Frida Toolkit` : logs généraux
- (futurs plugins ajouteront leurs tabs ici : Network packets, Hook hits, etc.)

**Status bar** (gauche) :
- `⚡ <process-name> | <gameName>/<buildId[:8]>` quand connecté (les 8 premiers chars du buildId)
- `🟧 Frida: not connected` quand pas
- Cliquable → refresh forced

**Editor area** : webviews ouvertes au clic sur une classe/méthode dans l'Explorer.

**Webview "Class Detail"** :
- Header : nom (label si dispo, sinon obf) + obf en sous-titre
- Boutons : Rename, Bookmark, Add note, Copy obf
- Sections : parents/interfaces, fields (avec leurs labels si dispo), méthodes (idem)
- Footer : RVA + Token IL2CPP

**Webview "Migration Review"** : ouverte depuis le panel Migrations. Montre `oldLabel.fingerprint` à gauche, `candidate.fingerprint` à droite, avec score + boutons Accept/Reject.

### 8. Plugin API (interne, pour v1.1+)

L'API est exposée comme une **constante exportée** depuis `core/api.ts`, importée par les modules `plugins/*`.

```typescript
// core/api.ts
export interface CoreApi {
  // Read-only profile state
  readonly profile: {
    current(): Profile | null;
    onAttach: vscode.EventEmitter<Profile>;
    onDetach: vscode.EventEmitter<void>;
  };
  
  // Labels (CRUD + events)
  readonly labels: LabelStore;
  
  // Annotations (CRUD + events)
  readonly annotations: AnnotationStore;
  
  // Per-plugin storage namespace
  storage(pluginId: string): PluginStorage;
  
  // RPC passthrough (escape hatch)
  rpc: {
    call<T>(method: string, args: unknown[]): Promise<T>;
  };
  
  // UI registration helpers
  ui: {
    addView(viewId: string, provider: vscode.TreeDataProvider<unknown>): vscode.Disposable;
    addCommand(commandId: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
    showWebview(opts: WebviewOptions): vscode.WebviewPanel;
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
}

interface PluginStorage {
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  list(): string[];
}
```

**Plugin storage path** : `<profile-root>/plugins/<pluginId>/`. Isolation entre plugins.

**Réservé pour v2** : événements UI (clic sur classe → plugin peut hooker), API plus riche pour modifier l'Explorer (color overlays), etc.

## Build-version detection (`detect.ts`)

```typescript
async function detectBuildId(rpc: RpcClient): Promise<{ buildId: string; source: BuildIdSource }> {
  // 1. Unity boot.config
  try {
    const path = await rpc.call("getDataPath");  // returns "F:/Jeux/Dofus-dofus3/Dofus_Data"
    const bootConfig = await rpc.call("readFile", [`${path}/boot.config`]);
    const m = /build-guid=([0-9a-f]+)/i.exec(bootConfig);
    if (m) return { buildId: m[1], source: "unity-boot-config" };
  } catch {}
  
  // 2. global-metadata.dat hash
  try {
    const path = await rpc.call("getDataPath");
    const buf = await rpc.call("readFileBytes", [`${path}/il2cpp_data/Metadata/global-metadata.dat`]);
    return { buildId: sha256(buf).slice(0, 32), source: "metadata-hash" };
  } catch {}
  
  // 3. Main binary hash
  try {
    const buf = await rpc.call("readMainModuleBytes");
    return { buildId: sha256(buf).slice(0, 32), source: "binary-hash" };
  } catch {}
  
  // 4. Last resort
  return { buildId: "unknown-" + Date.now(), source: "timestamp" };
}
```

L'agent Frida devra exposer 3 nouvelles RPC : `getDataPath`, `readFile`, `readFileBytes`, `readMainModuleBytes`. Coût : ~80 LOC à ajouter dans l'agent existant.

## Error handling

- **RPC unreachable** au boot → status bar "not connected", retry every 10s, no exception bubbled to user
- **RPC error per call** → log to Output channel, return null/empty to caller, don't crash
- **Profile corruption** (invalid JSON) → backup as `<file>.corrupted.<ts>.json`, start fresh, notify user via toast
- **Migration mismatch** (no candidate found) → label flagged "lost", visible in Migrations panel
- **Concurrent writes** (rare since single user) → last-write-wins, log warning if detected via mtime check

## Testing

Pour les modules **purs** (algorithmes, sans VSCode API ni RPC) → unit tests via **vitest** (rapide, peu de boilerplate, pas de dépendances natives) :

- `labels.ts` : CRUD operations, undo/redo, bulk import/export round-trip
- `annotations.ts` : CRUD, listing
- `migrations.ts` : matching algorithm avec fingerprints synthétiques (token match, structural match, lost cases)
- `detect.ts` : cascade des 3 mécanismes (mocks de RpcClient)

Pour les modules **avec VSCode API** (TreeDataProviders, webviews) → smoke test manuel via Extension Development Host (F5).

Pas d'e2e automatisé pour le v1 (Frida runtime test = trop coûteux et fragile).

## Roadmap après ce v1

| Sprint | Quoi | Effort |
|---|---|---|
| **v1** (cette spec) | Core | ~1.5 semaines |
| **v1.1** | Plugin Hooks (UI) | ~1 semaine |
| **v1.2** | Plugin Network (sniffer + decoder + rename messages/fields) | ~1.5 semaines |
| **v1.3** | Plugin Deobfusc engine (auto-suggest labels) | ~1 semaine |
| **v1.4** | Plugin Scripts (DSL ou TS pour AutoZaap, AutoTravel, etc.) | ~1-2 semaines |
| **v2** | Refactor en extensions VSCode séparées (publication marketplace) | ~1 semaine |

## Appendix : settings VSCode

L'extension expose ces réglages :

```json
{
  "fridaToolkit.rpcEndpoint": "http://localhost:3001/api/call",
  "fridaToolkit.profileRoot": "~/.frida-toolkit/profiles",
  "fridaToolkit.gameNameOverride": "",
  "fridaToolkit.showObfNamesAlongside": false,
  "fridaToolkit.search.maxResults": 100,
  "fridaToolkit.migration.autoMigrateThreshold": 0.95
}
```

## Appendix : commands VSCode (palette)

```
Frida: Connect / Refresh
Frida: Search... (Ctrl+Shift+F default)
Frida: Rename class...
Frida: Rename method...
Frida: Rename field...
Frida: Toggle obfuscated names
Frida: Open class detail by obf name
Frida: Bookmark current
Frida: Add note to current
Frida: Show migrations panel
Frida: Undo rename (Ctrl+Z when in toolkit context)
Frida: Redo rename
Frida: Export labels (JSON)
Frida: Import labels (JSON, merge)
Frida: Show profile info
```

## Out of scope (explicitly)

- Tags (categorization libre)
- Color coding par classe
- Plugin API marketplace / publication externe
- Multi-utilisateur / sync cloud / collaboration temps-réel
- Decompilation views (in-toolkit) — utilise des outils externes (Cpp2IL/ilspycmd) si besoin
- Mémoire / heap inspector — sera dans le plugin Hooks ou un futur plugin "Memory"
- Gestion native de plusieurs processes en parallèle (un toolkit = un process)
