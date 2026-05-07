# Frida IL2CPP Toolkit — Plugin Scripts (v1.4) — Design Spec

> Librairie de **fonctions TypeScript user-définies** (`autoTravel`, `autoZaap`, `godMode`, etc.), chacune nommée + paramétrée + invoquée à la demande depuis la web-app. Composent les ops cross-plugin existantes (instances + hooks + network) via une API `toolkit.*` injectée. Manuel uniquement, pas de triggers auto, pas de boucles background.

**Date** : 2026-05-07
**Branche cible** : à brancher fresh depuis `master` (ex: `feat/v1.4-plugin-scripts`). La branche `feat/v1.5-auto-rename` actuelle est vierge — soit renommée, soit abandonnée au profit d'une nouvelle.
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q5 résumées plus bas)
**Dépendances** : Toolkit Core v1 + plugins Instances/Hooks/Network déjà en place

---

## TL;DR

Un script = un fichier `.ts` dans `<profile>/plugins/scripts/` qui exporte par défaut un appel à `defineScript({...})`. Le backend watch le dossier, compile via esbuild à la volée, charge les définitions dans un registry, et expose la liste à la web-app. L'user voit la liste des scripts dans une page dédiée, choisit un script, remplit les params (form auto-généré depuis le `params` schema), clique Run. Le backend exécute la `run()` async avec un objet `toolkit` injecté, capture logs + résultat, stream le tout via WS.

Pas de vraie sandbox (l'user écrit ses propres scripts sur sa propre machine), pas de triggers auto (toujours invoqué manuellement), pas d'éditeur intégré (l'user reste dans VSCode + autocomplete via un `.d.ts` qu'on génère).

**Out of scope v1.4** : triggers (`@onPacket`, `every(10s)`), Monaco web-app embedded, sandbox stricte, hotkeys in-game, sharing/marketplace.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Forme du script | **Initial open question** — l'user voulait voir le champ des possibles avant de cadrer. Proposition de 3 tiers (one-shot / réactif / boucles). |
| Q2 | Triggers | **A — Manuel uniquement pour v1**. Click Run, params, exécute, retourne. Reactive et background reportés. |
| Q3 | Syntaxe déclaration | **A — `defineScript({...})` factory**. Self-describing, pas besoin de parser le TS, type-safe via generics. |
| Q4 | Lieu d'édition | **A — VSCode externe + file-watch**. Scripts dans `<profile>/plugins/scripts/*.ts`, autocomplete via `.d.ts` généré. Pas d'éditeur intégré. |
| Q5 | Scope API `toolkit.*` | **Instances + Hooks + Network** pour v1. `labels.resolve` skip (résolution implicite faite par les méthodes). |

---

## Architecture

Sept fichiers nouveaux dans 4 zones, plus 1 `.d.ts` généré par profile.

| Fichier | Rôle |
|---|---|
| `app/backend/core/scripts/script-loader.ts` | Watch `<profile>/plugins/scripts/*.ts` via chokidar, compile via esbuild, charge via `new AsyncFunction`, valide la shape `defineScript({...})`, maintient le registry en mémoire |
| `app/backend/core/scripts/script-runner.ts` | Exécute `def.run(params, toolkit)` avec timeout, capture logs/erreurs, re-map stack-traces via sourcemap inline, broadcast events WS |
| `app/backend/core/scripts/toolkit-api.ts` | Construit l'objet `toolkit` injecté — wraps `instanceRegistry`, `hookManager`, `networkSniffer` ; résout friendly→obf via `LabelStore` |
| `app/backend/core/scripts/types.ts` | Types `ScriptDefinition`, `ParamSpec`, `RunResult`, `ScriptLog`, `Toolkit` |
| `app/backend/core/scripts/types-emitter.ts` | Génère `<profile>/plugins/scripts/_types/toolkit.d.ts` + `tsconfig.json` au premier load. Régénéré si versions changent. |
| `app/backend/routes/scripts.ts` | `GET /api/scripts`, `POST /api/scripts/:id/run`, WS `script-log`/`script-result`/`script-list-changed` |
| `app/frontend/pages/scripts.ts` | Page : liste à gauche, form de params + console à droite, intégration WS |
| `app/frontend/components/script-runner.ts` | Sub-component : form auto-généré depuis `ParamSpec`, bouton Run, streaming logs, résultat |

Wiring dans `app/backend/session.ts` : à l'attache d'un profile, instancie `ScriptLoader(profileScriptsDir)` + `ScriptRunner(loader, instanceRegistry, hookManager, networkSniffer)`. Détache → unwatch + clear registry. Forward des events WS dans `ws-bridge.ts`.

Pas d'agent Frida-side modifié — réutilise l'API runtime existante. Latence par op `toolkit.*` = ~10-50ms (round-trip Node↔Frida agent), acceptable pour scripts manuel-invoqués.

---

## Data model

### Côté core — `app/backend/core/scripts/types.ts`

```ts
export type ParamSpec =
  | { type: "string";  label?: string; required?: boolean; default?: string;  placeholder?: string }
  | { type: "number";  label?: string; required?: boolean; default?: number;  min?: number; max?: number }
  | { type: "boolean"; label?: string; default?: boolean }
  | { type: "enum";    label?: string; values: readonly string[]; default?: string };

export interface ScriptDefinition<P extends Record<string, unknown> = Record<string, unknown>> {
  name: string;                     // unique within registry, used as id
  description?: string;
  params: { [K in keyof P]: ParamSpec };
  timeoutMs?: number;               // default 30_000
  run: (args: P, toolkit: Toolkit) => Promise<unknown>;
}

export interface RegistryEntry {
  id: string;                       // = filename without .ts
  filePath: string;
  status: "loaded" | "compile-error" | "validation-error";
  definition?: ScriptDefinition;
  error?: string;                   // when status != "loaded"
  loadedAt: string;                 // ISO 8601
}

export interface RunResult {
  runId: string;
  scriptId: string;
  status: "ok" | "error" | "timeout";
  result?: unknown;                 // serializable, JSON.stringify success required
  error?: { message: string; stack?: string };  // stack source-mapped
  startedAt: string;
  durationMs: number;
}

export interface ScriptLog {
  runId: string;
  level: "info" | "warn" | "error";
  args: unknown[];                  // preserve as-is, JSON.stringify on send
  ts: string;
}
```

### Toolkit API — `app/backend/core/scripts/toolkit-api.ts`

```ts
export interface Toolkit {
  instances: {
    find(label: string): Promise<InstanceHandle>;       // throws if 0 or N>1 matches
    findAll(label: string): Promise<InstanceHandle[]>;
    capture(label: string, opts?: CaptureOpts): Promise<InstanceHandle>;
    read(handle: InstanceHandle, field: string): Promise<unknown>;
    write(handle: InstanceHandle, field: string, value: unknown): Promise<void>;
    call(handle: InstanceHandle, method: string, args?: unknown[]): Promise<unknown>;
    list(): Promise<InstanceSummary[]>;
  };
  hooks: {
    install(target: string, opts: HookInstallOpts): Promise<HookHandle>;
    remove(handle: HookHandle): Promise<void>;
    onceCall(target: string, opts?: { timeoutMs?: number }): Promise<HookCallEvent>;
  };
  network: {
    send(messageType: string, payload: Record<string, unknown>): Promise<void>;
    onceReceive(messageType: string, opts?: { timeoutMs?: number }): Promise<NetworkPacket>;
    recent(messageType?: string, limit?: number): Promise<NetworkPacket[]>;
  };
  log:   (...args: unknown[]) => void;
  warn:  (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  sleep: (ms: number) => Promise<void>;
}
```

Tous les paramètres `label` / `target` / `messageType` sont des **friendly labels** (ex: `"PlayerManager"`, pas `"fzc"`). La résolution friendly→obf est faite à l'intérieur de chaque méthode via le `LabelStore` global, donc les scripts survivent aux updates du jeu (le système de migrations s'occupe du reste). Si la résolution échoue (label inconnu), throw avec un message clair.

---

## Lifecycle d'un script

### Load (au démarrage du plugin ou hot-reload)

1. `script-loader.ts` lit le `.ts`.
2. Compile via `esbuild.transform(source, { loader: "ts", format: "cjs", sourcemap: "inline" })` → JS string + sourcemap inline.
3. Construit `new AsyncFunction("module", "require", "defineScript", code)` :
   - `module = { exports: {} }`
   - `require = (id) => { throw new Error(`require('${id}') interdit dans les scripts`); }`
   - `defineScript = (def) => def` (identity function)
4. Exécute la function. Récupère `module.exports.default` ou `module.exports` (CJS classique).
5. Valide la shape :
   - `name: string non vide` → unique dans le registry
   - `params: object` avec shape `ParamSpec` valide pour chaque clé
   - `run: function async`
   - `timeoutMs?: number > 0`
6. Si valide → `RegistryEntry { status: "loaded", definition }`.
7. Si erreur de compile → `{ status: "compile-error", error: msg }`.
8. Si erreur de validation → `{ status: "validation-error", error: msg }`.
9. Broadcast WS `script-list-changed`.

### Hot-reload (chokidar)

- `change` ou `add` sur `*.ts` → recompile ce fichier seul, remplace l'entrée registry, broadcast `script-list-changed`.
- `unlink` → retire du registry, broadcast.
- Erreurs de load n'interrompent pas le watch — l'entrée reste avec status `compile-error` et l'user voit l'erreur en UI.
- Le watcher filtre strict `**/*.ts` à la racine du dossier scripts (pas `_types/`, pas sous-dossiers v1).

### Run

`script-runner.run(scriptId, paramValues)` :

1. **Validation params** : pour chaque clé dans `def.params`, valide `paramValues[key]` :
   - Type cohérent (`number` est un nombre, etc.)
   - `required: true` et undefined → reject 400 `"missing required param: mapId"`
   - `min`/`max` violés → reject 400
   - `enum` valeur hors `values` → reject 400
   - Param présent mais pas dans schema → reject 400 (pas de "extra params" silencieux)
2. **Construction toolkit** : closure sur les services + `runId` pour scoping des logs.
3. **Execution avec timeout** :
   ```ts
   const result = await Promise.race([
     def.run(paramValues, toolkit),
     timeoutAfter(def.timeoutMs ?? 30_000),
   ]);
   ```
4. **Streaming** : à chaque `toolkit.log(...)`/`warn`/`error` pendant le run → broadcast WS `script-log`.
5. **Résultat** : à la fin (succès, erreur, ou timeout) → broadcast `script-result`.
6. **Stack-trace re-mapping** : si erreur, parse la stack JS transpilée, lookup dans le sourcemap inline, réécrit chaque ligne pour pointer vers `.ts` source. L'UI affiche les bonnes lignes.
7. **Sérialisation du résultat** : `JSON.stringify(result)` doit réussir. Si non (cycle, BigInt, function, ...) → status `error` avec message `"result not serializable: ${msg}"`.

### Concurrence

- Un script peut tourner en parallèle d'un AUTRE script (pas de queue globale).
- Le **même** script ne peut pas tourner deux fois simultanément. Click Run pendant un run en cours → reject 409 `"script already running"`.
- Les ops Frida sous-jacentes (read/write/call) sérialisent déjà via le bridge WS du Frida agent — pas de course condition côté toolkit.

---

## Auto-complete dans VSCode

Au premier load (ou si la version du toolkit change), `types-emitter.ts` écrit deux fichiers dans `<profile>/plugins/scripts/_types/` :

### `_types/toolkit.d.ts`

Contient les déclarations de `Toolkit`, `defineScript`, `ParamSpec`, `InstanceHandle`, `HookHandle`, `NetworkPacket`, etc. Généré à partir des types backend (copie statique, pas de dynamic re-export).

### `_types/tsconfig.json` (placé à la racine `<profile>/plugins/scripts/`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "esnext",
    "moduleResolution": "node",
    "strict": true,
    "noEmit": true,
    "paths": {
      "@toolkit/scripts": ["./_types/toolkit.d.ts"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["_types/**"]
}
```

L'user ouvre `<profile>/plugins/scripts/` dans VSCode → autocomplete + check de types out-of-the-box, sans installer de package npm. Les imports de `@toolkit/scripts` sont résolus via les `paths`.

Le dossier `_types/` est régénéré à chaque démarrage du backend (idempotent), donc l'user n'a pas à se soucier de le maintenir. Il peut le commit ou pas, c'est son choix.

---

## Routes & API

### `GET /api/scripts`

Retourne la liste des entries du registry :

```json
{
  "scripts": [
    {
      "id": "auto-travel",
      "filePath": ".../scripts/auto-travel.ts",
      "status": "loaded",
      "definition": {
        "name": "autoTravel",
        "description": "Travel to a specific map by mapId.",
        "params": { "mapId": { "type": "number", "label": "Map ID", "required": true }, ... },
        "timeoutMs": 30000
      },
      "loadedAt": "2026-05-07T18:42:11.000Z"
    },
    { "id": "broken", "status": "compile-error", "error": "Unexpected token ...", ... }
  ]
}
```

Le champ `definition.run` est intentionnellement omis (pas sérialisable, et le frontend n'en a pas besoin).

### `POST /api/scripts/:id/run`

Body : `{ params: Record<string, unknown> }`

Réponses :
- `200 { runId: "..." }` — exécution démarrée. Suivre via WS `script-log`/`script-result` filtré sur `runId`.
- `400 { error: "missing required param: mapId" }` — validation params.
- `404 { error: "script not found" }`.
- `409 { error: "script already running" }`.
- `422 { error: "script in compile-error state" }` — script chargé mais cassé.

### WebSocket events

- `script-list-changed` — broadcast après chaque hot-reload, le frontend re-fetch `/api/scripts`.
- `script-log` — `{ runId, level, args, ts }` streamé pendant l'exécution.
- `script-result` — `{ runId, scriptId, status, result?, error?, startedAt, durationMs }` à la fin.

---

## UI : page Scripts

Layout 3-zones, dans une nouvelle page `app/frontend/pages/scripts.ts` ajoutée à la nav principale.

```
┌───────────────────┬──────────────────────────────────────┐
│ Scripts (8)       │ autoTravel                            │
│ ─────────────     │ Travel to a specific map by mapId.    │
│ ▶ autoTravel      │ ─────────────────────────────────────│
│   autoZaap        │ Map ID*       [12345]                │
│   godMode         │ Force reload  ☐                      │
│   dumpInventory   │                                       │
│ ⚠ broken-script   │              [▶ Run]  [↻ Reload]    │
│   ─────────────   │ ─────────────────────────────────────│
│ + scripts/ folder │ ▶ Run #3 (started 12:04:11)           │
│                   │   12:04:11.213 [info] currentMapId=42 │
│                   │   12:04:11.487 [info] → map 12345     │
│                   │   ✓ ok (276ms) result: "→ map 12345"  │
└───────────────────┴──────────────────────────────────────┘
```

- **Liste gauche** : tous les scripts du registry. Icône `▶` (loaded), `⚠` (compile-error / validation-error), `✓` (last-run-ok), `✗` (last-run-error). L'état "last-run" est en-mémoire backend uniquement, perdu au restart (pas de persistence). Click ouvre l'éditeur de params à droite.
- **Form auto-généré** depuis `params: ParamSpec[]` :
  - `string` → `<input type="text">` (placeholder si défini)
  - `number` → `<input type="number">` (min/max attributes)
  - `boolean` → `<input type="checkbox">`
  - `enum` → `<select>` avec les `values`
  - Required en rouge si vide. Validation côté client + re-validation côté serveur.
- **Console en bas** : log streamé via WS, format `HH:MM:SS.mmm [level] args.join(' ')`. Auto-scroll au plus récent. Bouton "Clear" et "Pin run" (figer un run actuel, démarrer le suivant en parallèle visuel — pour comparer 2 runs).
- **Footer liste** : bouton "Open scripts folder" — backend renvoie le path absolu, frontend `navigator.clipboard.writeText(path)` + toast "chemin copié, colle-le dans VSCode". Intégration directe `code <path>` reportée à v1.x.
- **Bouton "Reload"** sur un script : force un re-load du fichier (utile si chokidar a raté un event).

WebSocket : la page maintient un map `runId → logs[]` côté client. À chaque `script-log`, append. À chaque `script-result`, marque le run comme terminé. Garde les 10 derniers runs en historique.

---

## Tests

Stratégie TDD vitest, ~35 nouveaux tests.

### `app/test/backend/core/scripts/script-loader.test.ts` (10)

- ✓ Compile un fichier `.ts` valide → registry entry status `loaded`
- ✓ Erreur de syntaxe TS → entry status `compile-error` avec message
- ✓ `defineScript({ name: "" })` (name vide) → `validation-error`
- ✓ `defineScript({ run: notAFunction })` → `validation-error`
- ✓ Deux fichiers même `name` → second loaded entry status `validation-error: duplicate name`
- ✓ Hot-reload sur change → entry remplacée
- ✓ Unlink → entry retirée
- ✓ Add nouveau fichier → entry ajoutée + broadcast `script-list-changed`
- ✓ `require("fs")` dans script → entry `validation-error: require('fs') interdit`
- ✓ `_types/` ignoré par le watcher (pas de tentative de load)

### `app/test/backend/core/scripts/script-runner.test.ts` (12)

- ✓ Params valides → exécute, status `ok`, résultat retourné
- ✓ Param required absent → reject 400 `"missing required param: ..."`
- ✓ Param mauvais type → reject 400
- ✓ Param `number` hors `min`/`max` → reject 400
- ✓ Param `enum` valeur hors `values` → reject 400
- ✓ Param extra (pas dans schema) → reject 400 (pas silencieux)
- ✓ Timeout par défaut 30s déclenché → status `timeout`
- ✓ `timeoutMs` custom respecté
- ✓ Erreur dans `run()` → status `error`, stack source-mappée vers `.ts` original
- ✓ `toolkit.log/warn/error` → events WS `script-log` bien formés (level + args + ts + runId)
- ✓ `toolkit.sleep(100)` rend la main pendant 100ms
- ✓ Résultat non-sérialisable (cycle) → status `error: result not serializable`
- ✓ Run en cours + second run même script → reject 409
- ✓ Run en cours + run d'un autre script → exécute en parallèle

### `app/test/backend/core/scripts/toolkit-api.test.ts` (5)

- ✓ `instances.find("PlayerManager")` résout via mock LabelStore puis appelle `instanceRegistry.find(obf)`
- ✓ `instances.find("Unknown")` → throw `"label not found: Unknown"`
- ✓ `instances.find("Ambiguous")` (N>1 résultats) → throw `"label resolves to N matches"`
- ✓ `hooks.onceCall("X.foo")` install hook + résout au prochain event + remove hook
- ✓ `network.send` propage label friendly + payload au sniffer correctement

### `app/test/backend/routes/scripts.test.ts` (3)

- ✓ `GET /api/scripts` retourne registry sans champ `run`
- ✓ `POST /api/scripts/:id/run` exécute et stream events WS pendant + résultat à la fin
- ✓ `POST /api/scripts/:id/run` rejette params invalides en 400

### Frontend — `app/test/frontend/pages/scripts.test.ts` (~5)

- ✓ Render liste depuis `/api/scripts` mock
- ✓ Click script → form params apparaît avec bons inputs par type
- ✓ Submit form → POST `/run` avec bon payload
- ✓ WS `script-log` apparaît dans console live
- ✓ WS `script-result` marque run comme terminé + affiche résultat

### Smoke test (manuel sur Dofus)

- 1 script `autoTravel({ mapId })` créé dans le profile.
- Hot-reload détecté → apparaît dans liste UI.
- Run avec `mapId: <map valide>` → log `currentMapId=...` → call → travel observable in-game.
- Param invalide → erreur claire, pas de crash.
- Erreur dans le script (ex: `instances.find` sur label inconnu) → stack pointant vers la bonne ligne du `.ts`.

**Cible** : ~230 tests verts (baseline ~195 + ~35 nouveaux).

---

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| **Script throw / loop infini** bloque le serveur | `Promise.race` timeout 30s par défaut, override via `timeoutMs`. Pas de cancellation cooperative côté script (v1 — l'user attend ou redémarre le toolkit). |
| **Stack-trace JS transpilé** illisible pour l'user | esbuild emit sourcemap inline, runner re-map avant de broadcast. Tests dédiés pour vérifier la source-map fonctionne. |
| **Hook installé dans script reste vivant** après return | **Intentionnel** — `godMode` doit pouvoir installer hook et retourner. Documentation explicite dans le `.d.ts`. Possible v1.x : helper `toolkit.hooks.installScoped()` qui auto-cleanup en fin de script. |
| **Hot-reload casse un script en plein run** | Le run en cours utilise sa snapshot du `ScriptDefinition` ; le reload ne touche que les invocations futures. Test dédié. |
| **User pollue le dossier scripts** avec du non-`.ts` | Watcher filtre strict `**/*.ts` à la racine du dossier scripts. `_types/` ignoré. Sous-dossiers ignorés (v1). |
| **Pas de vraie sandbox** : `new AsyncFunction` n'a pas accès `require` mais peut accéder aux globals (`globalThis`, `process`, `Buffer`) | C'est intentionnel pour v1. L'user écrit ses propres scripts sur sa machine. Si v2 introduit du sharing/marketplace, on reconsidère (isolated-vm). |
| **Conflit de noms** entre scripts (deux fichiers avec `name: "autoTravel"`) | Validation : second entry → `validation-error: duplicate name 'autoTravel' (already used by ...)`. Pas de tentative auto-rename. |
| **`.d.ts` généré désynchronisé** avec l'API actuelle | Régénéré à chaque démarrage du backend (idempotent). L'user peut force-régénérer via un bouton UI futur si besoin. |

---

## Out of scope v1.4

- **Triggers auto** (`@trigger onPacket(...)`, `every(10s)`, `on(event)`) → v1.5 si Tier 2 redevient prioritaire. Demande lifecycle background, kill-switch, parallèle sécurisé.
- **Sandbox réelle** (vm2 deprecated, isolated-vm) → tant que l'user écrit ses propres scripts, pas nécessaire.
- **Monaco intégré dans la web-app** → l'user édite dans VSCode. Plus simple, plus puissant.
- **Hotkey bindings in-game** (F2 → run script) → demande input listener OS-level (RawInput Windows / IOHIDManager macOS), gros chantier.
- **Scripts qui appellent d'autres scripts** (composition) → `toolkit.scripts.run("autoTravel", { mapId })` plus tard si le besoin émerge.
- **Versioning / undo des scripts** → c'est du Git côté user, pas notre problème.
- **Sharing / marketplace** → v2.
- **Sub-dossiers dans `<profile>/plugins/scripts/`** (organisation par catégorie) → v1.x, juste un changement de glob du watcher.
- **`labels.resolve` exposé** dans `toolkit.*` → résolution implicite dans chaque méthode suffit pour v1. Ajouter si l'user a un cas d'usage concret.
- **Cancellation cooperative** (script qui peut check `toolkit.aborted`) → useful for long scripts but adds complexity. v1.x.

---

## Critère d'acceptation v1.4

- ✅ ~230 tests verts (baseline ~195 + ~35 nouveaux)
- ✅ Build vite + tsc clean (incluant esbuild dependency installé)
- ✅ Smoke-test : créer `auto-travel.ts` dans le profile Dofus → apparaît dans UI → run avec mapId valide → travel observable in-game → log + résultat affichés en UI
- ✅ Hot-reload : éditer le `.ts`, sauver, voir l'UI broadcast `script-list-changed` automatiquement
- ✅ Erreur de compile : taper de la syntaxe invalide → entry passe en `compile-error` avec message clair, pas de crash backend
- ✅ Erreur de run : `instances.find("Unknown")` → stack pointe vers la bonne ligne du `.ts`, pas du JS transpilé
- ✅ Autocomplete VSCode marche dans le dossier `<profile>/plugins/scripts/` après premier load (test manuel)
