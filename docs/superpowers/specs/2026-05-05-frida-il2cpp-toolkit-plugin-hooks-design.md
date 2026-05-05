# Frida IL2CPP Toolkit — Plugin Hooks (v1.1) — Design Spec

> Premier vrai consommateur de la Plugin API du Toolkit Core. Hook UI + live log
> + summary, optimisé pour un workflow **probe/observation** (comprendre ce que
> fait le jeu, pas modifier). Templates de hooks essentiels, persistance disarmed
> par profil, agent-side execution avec event stream async.

**Date** : 2026-05-05
**Branche cible** : `toolkit-core-v1`
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q6 résumées plus bas)
**Dépendances** : Toolkit Core v1 (`v1.0.0-core`) + finitions tech-debt v1 (commit `fc10495`) + rpc-agent class-index/singleton-cache (commit `6851fc8`)

---

## TL;DR

Un plugin VSCode interne (`src/plugins/hooks/`) qui ajoute :

1. **Tree sidebar "Hooks"** — liste des hooks définis (installed/disarmed), toggle, edit, delete.
2. **Webview "Hook Log"** — onglets *Stream* (live scroll) et *Summary* (compteurs et derniers args/retval par hook).
3. **4 templates de hooks P0** : log args+retval, no-op, force return, log+stack trace.
4. **Persistance par profil** via `DiskPluginStorage` — au prochain attach, hooks réapparaissent **disarmed** (sûr).
5. **Agent-side execution** — l'agent installe la hook function en TS Frida, envoie les events via `send()`. Pas de roundtrip RPC par hit.

**Out of scope v1.1** : modify args, conditional log, custom JS snippet, patch static field via UI, auto-arm on attach.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Mode primaire | **A — Probe/observation** (comprendre, pas modifier) |
| Q2 | Affichage des hits | **C — Stream temps réel + Summary tabs (les deux)** |
| Q3 | Templates P0 | **1 + 2 + 3 + 5** : log args+ret, no-op, force return, log+stack |
| Q4 | UI architecture | **A — Tree sidebar + webview Hook Log avec tabs** |
| Q5 | Persistance | **B — Per-profile, disarmed at attach** (sûr, pas d'auto-arm) |
| Q6 | Stack trace | **C — N=5 premiers hits puis off** |

---

## Goals / Non-goals

### Goals

- Premier vrai consommateur de la Plugin API → valide la surface et débusque les manques.
- Permettre à l'utilisateur d'installer un hook en **<10s** (right-click classe → Hook).
- Stream live qui ne lag pas même à 100 hits/sec (batching + ring buffer).
- Summary qui répond en 1 coup d'œil à "qu'est-ce qui se passe quand je clique X ?".
- Persistance disarmed → workflow "réinstaller mes 3 probes habituelles" sans re-saisir les noms.
- Découplage agent ↔ plugin propre — le jour où l'agent devient un plugin séparé (option C de NEXT-SESSION), le plugin VSCode reste tel quel.

### Non-goals

- Pas de modification d'args, ni de conditional log, ni de custom JS dans v1.1.
- Pas d'auto-arm on attach (un hook foireux pourrait freeze l'attach).
- Pas de hot-reload de l'agent code (juste hot-reload des hooks defs eux-mêmes via revert+reinstall).
- Pas de persistance cross-profile : tes hooks Dofus n'apparaissent pas quand tu attaches à un autre jeu.
- Pas de "mode batch" (installer plusieurs hooks d'un coup) — un par un en v1.1.

---

## Architecture

### Vue d'ensemble

```
┌─────────────────────── VSCode Extension ────────────────────────┐
│                                                                 │
│  CoreApi (existant)                                             │
│   • rpc.call() / ui.* / storage(pluginId) / profile / labels    │
│                                                                 │
│  Plugin Hooks (NEW, src/plugins/hooks/)                         │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │ index.ts — plugin activate(coreApi)                     │   │
│   │  ├─ HookStore  (CRUD + persist via DiskPluginStorage)   │   │
│   │  ├─ HookEventBus (subscribe Frida script.message)       │   │
│   │  ├─ HooksTreeProvider (TreeDataProvider sidebar)        │   │
│   │  ├─ HookLogPanel (webview Stream + Summary tabs)        │   │
│   │  └─ commands (Add/Edit/Toggle/Delete/OpenLog/Clear)     │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│             RPC ↓                       ↑ Frida send()          │
└────────────────────────────────────────────────────────────────┘
                                  ↕
┌────────────────────── Frida Agent (rpc-agent/) ────────────────┐
│  hooks.ts (étendu)                                              │
│   • installHook(spec: HookSpec): { hookId: string }             │
│   • revertHook(hookId: string): { reverted: boolean }           │
│   • listInstalledHooks(): InstalledHook[]                       │
│   • clearAllHooks(): { count: number }                          │
│                                                                 │
│  lib/hook.ts (étendu)                                           │
│  stack-trace.ts NEW (factor du methodTable de sender.ts)        │
└────────────────────────────────────────────────────────────────┘
```

### Frontière Plugin ↔ CoreApi

Le plugin Hooks consomme uniquement :
- `coreApi.profile.current()` + `onAttach`/`onDetach` → invalider l'état quand on change de build.
- `coreApi.rpc.call()` → installer/révoquer côté agent.
- `coreApi.storage("hooks")` → persister la liste des hooks par profil.
- `coreApi.ui.addView()` / `addCommand()` → enregistrer le tree + commandes.
- `coreApi.ui.showWebview()` → ouvrir le panel Hook Log.
- `coreApi.labels` → afficher les noms friendly (rename live) dans le tree et le log.

**Manque identifié** : la `CoreApi` actuelle ne donne PAS accès au flux `script.message` de Frida. C'est le seul ajout nécessaire au CoreApi pour que ce plugin fonctionne. Voir section "Modifications du CoreApi".

### Frontière Agent ↔ Plugin

L'agent expose une surface **type-safe et agnostique** :

```ts
// rpc-agent/hooks.ts — types partagés (à dupliquer côté plugin)
export type HookTemplate = "log" | "noop" | "force-return" | "log-stack";

export interface HookSpec {
    template: HookTemplate;
    className: string;        // obfuscated short name (e.g. "ecu", "MapRenderer")
    methodName: string;
    /** Required for `force-return`. Ignored for others. */
    forceReturnValue?: unknown;
    /** Required for `log-stack`. How many initial hits get a backtrace. Default 5. */
    stackCaptureCount?: number;
}

export interface InstalledHook {
    hookId: string;           // server-assigned, opaque to client
    spec: HookSpec;
    installedAt: number;      // epoch ms
}

export interface HookEvent {
    type: "hook-event";
    hookId: string;
    ts: number;
    self: string | null;      // "ClassName@handle" or null for static
    args: string[];           // stringifyValue per arg
    retval: string | null;    // null if void or before return; populated after invoke
    error?: string;           // if original throws, captured here, original re-thrown
    stackFrames?: string[];   // present only for first N hits when template is log-stack
}
```

L'agent **ne sait pas** qu'un plugin VSCode existe. Si demain l'agent devient un plugin séparé, il garde la même API.

---

## Composants

### A — Agent-side : `rpc-agent/hooks.ts` (étendu)

**État interne** :
```ts
// Module-level — Frida agent context
const _installedHooks: Map<string, {
    spec: HookSpec;
    method: Il2Cpp.Method;     // pour pouvoir revert()
    hitCount: number;          // pour stack-capture countdown
    installedAt: number;
}> = new Map();
let _hookIdCounter = 0;
```

**Exports** :
```ts
export function installHook(spec: HookSpec): { hookId: string };
export function revertHook(hookId: string): { reverted: boolean };
export function listInstalledHooks(): InstalledHook[];
export function clearAllHooks(): { count: number };
```

**Implémentation `installHook` (pseudocode)** :
```
- valide spec (template connu, className/methodName non-vides)
- résout klass via findClassExact, throw NotFoundError si pas trouvé
- résout method via klass.tryMethod(name), throw NotFoundError si pas trouvé
- alloue hookId = `h${_hookIdCounter++}`
- selon template:
   * log:        method.implementation = wrapper qui invoke + send(HookEvent sans stack)
   * log-stack:  idem mais capture backtrace sur les hitCount<5 premiers
   * noop:       method.implementation = () => undefined
   * force-return: method.implementation = () => coerce(spec.forceReturnValue, retType)
- enregistre dans _installedHooks
- return { hookId }
```

**Concurrence / re-entrancy** : un hook qui appelle send() puis invoke() pourrait être réentré (si le code hooké re-appelle la même méthode). Frida gère ça nativement via `method.implementation` — pas besoin de lock.

**Stack trace** :
- Factor le `methodTable` + `resolveFrame` de `sender.ts` dans un nouveau `lib/stack-trace.ts` réutilisable.
- Lazy build au premier appel (~349k entries, build ~1s).
- Public API : `getStackFrames(context, maxDepth = 20): string[]`.

### B — Plugin entry : `dofus-app/vscode-extension/src/plugins/hooks/index.ts`

```ts
export function activateHooksPlugin(coreApi: CoreApi, ctx: vscode.ExtensionContext): vscode.Disposable {
    const store = new HookStore(coreApi);
    const eventBus = new HookEventBus(coreApi);
    const treeProvider = new HooksTreeProvider(store, coreApi.labels);
    const logPanel = new HookLogPanel(coreApi.ui, eventBus, store, coreApi.labels);

    const disposables: vscode.Disposable[] = [];
    disposables.push(coreApi.ui.addView("fridaHooks", treeProvider));
    disposables.push(...registerHookCommands({ store, treeProvider, logPanel, coreApi }));

    // Refresh the store when the user attaches to a (potentially different) profile.
    disposables.push(coreApi.profile.onAttach.event(() => {
        store.reload();
        treeProvider.refresh();
    }));

    return vscode.Disposable.from(...disposables);
}
```

`extension.ts` du Core appelle `activateHooksPlugin(coreApi, context)` après `createCoreApi()`.

### C — `HookStore` (extension state + persist)

Responsabilité : maintenir la liste des hooks définis, leur état (installed/disarmed), persister dans `<profile>/plugins/hooks/storage.json`.

```ts
interface StoredHook {
    /** UUID — identique à hookId quand installed, sinon stable côté disque. */
    id: string;
    spec: HookSpec;
    /** Set when installed agent-side. Reset on detach. */
    installedHookId: string | null;
    /** True if this entry should auto-install on attach (NOT in v1.1 — toujours false). */
    autoArm: false;
    addedAt: number;
}

class HookStore {
    private hooks: StoredHook[] = [];
    constructor(private readonly coreApi: CoreApi) {
        this.reload();
    }
    reload(): void { /* lit DiskPluginStorage["hooks"] */ }
    list(): StoredHook[];
    add(spec: HookSpec): StoredHook;
    update(id: string, spec: HookSpec): void;
    remove(id: string): void;

    async install(id: string): Promise<void>;
    async uninstall(id: string): Promise<void>;
    async uninstallAll(): Promise<void>;

    onChange: vscode.EventEmitter<void>;
}
```

**À l'attach (Q5.b)** : tous les hooks chargés du disque ont `installedHookId === null` (disarmed). L'utilisateur clique pour install.

### D — `HookEventBus`

Branché sur le flux `script.message` de Frida. Émet uniquement les events `type === "hook-event"`.

**Implémentation** : étend `frida-direct.ts` (mode direct) et `rpc.ts` (mode HTTP) pour exposer un `onMessage(callback)` que le plugin consomme.

**Déduplication de subscribers** : un seul abonnement Frida par session, multi-listener côté JS.

**Backpressure** : si la webview est cachée, le bus garde un ring buffer de 10k events; quand la webview revient, elle re-render le buffer entier d'un coup.

### E — `HooksTreeProvider`

```
Hooks (sidebar Frida)
├── 🟢 ecu.xbe  [log]                 ← installed, hit 142×
├── ⚪ MapRenderer.cywh  [force-return = 0]  ← disarmed
├── 🟢 dvi.GetInteractiveById  [log+stack]   ← installed, hit 5/N stack
└── ⚪ Player.TakeDamage  [noop]      ← disarmed
```

- Icône vert = installed, gris = disarmed.
- Description = template + (count si installed).
- Tooltip = full obfuscated `className.methodName` + paramètres si dispo.
- Inline action buttons (via `view/item/context`) : install/uninstall toggle, edit, delete.
- Click sur l'item = ouvre le Hook Log (ou jump à la classe via `frida.openClassDetail`).

**Filtre temps réel** : `coreApi.labels.onChange` → tree refresh pour update les noms friendly affichés.

### F — `HookLogPanel` (webview)

**Tab Stream** :
- Liste virtualisée des events (last 10 000), auto-scroll en bas si pas pause.
- Toolbar : Pause/Resume, Clear, Export (JSON), Filter input (texte plein), kind filter (per-template), hookId filter (per-hook).
- Chaque ligne : `[ts] ClassName.method ← args=(…) → retval` (cliquable pour expand args/retval/stack frames complets).
- Couleur : log=blanc, log-stack=cyan, noop=gris, force-return=jaune.

**Tab Summary** :
- Tableau virtualisé : `Hook | Hits | Last hit | Last args | Last retval | Last stack`.
- Tri par défaut : Hits desc.
- Click sur une ligne = filtre le Stream à ce hookId.

**Lifecycle** :
- Pas créé au boot ; créé à la première install OU à `Frida: Open Hook Log`.
- `retainContextWhenHidden: true` (le ring buffer survit cache/show).
- `onDidDispose` → notify le store qu'on a perdu la vue (les events continuent d'arriver agent-side et sont bufférisés).

### Hot-reload sémantique

"Edit" d'un hook = `revertHook(oldId)` puis `installHook(newSpec)` côté agent. **Pas** de live-patch en place — c'est plus simple, plus sûr, et l'agent Frida revert+reinstall en quelques ms. L'`hookId` change après edit ; les events précédents restent dans le buffer du Stream avec leur ancien hookId (juste affichés comme un autre hook dans le Summary).

### G — Commandes

```
frida.hooks.add               → input className/methodName/template/params, persist + auto-install
frida.hooks.addFromClass      → contextual : right-click classe dans Process Explorer → add
frida.hooks.addFromMember     → contextual : right-click member → add
frida.hooks.toggle            → install ↔ uninstall un hook du tree
frida.hooks.edit              → open input avec valeurs courantes, replace spec, re-install si installed
frida.hooks.delete            → remove du store + uninstall si installed
frida.hooks.openLog           → ouvre le HookLogPanel
frida.hooks.clearAll          → uninstall tous (le store survit) + confirme via dialog
```

---

## Modifications du CoreApi

L'API actuelle ne donne PAS accès au flux `script.message` Frida. **Add** :

```ts
export interface CoreApi {
    // … existant
    onAgentMessage: vscode.Event<unknown>;
}
```

Implementation :
- `frida-direct.ts` : déjà reçoit `script.message` (frida-node) ; expose un `EventEmitter<unknown>` que `createCoreApi` plug.
- `rpc.ts` (HTTP) : ne reçoit pas de stream actuellement. Pour v1.1 on désactive le plugin Hooks en mode HTTP avec un message clair (`"Hooks plugin requires direct Frida mode"`) — la persistence reste utilisable, juste pas le stream.

C'est le **seul changement breaking** de la CoreApi en v1.1. À documenter.

---

## Persistance — schema disque

Path : `<profile>/plugins/hooks/storage.json`

```json
{
    "hooks": [
        {
            "id": "uuid-v4",
            "spec": {
                "template": "log",
                "className": "ecu",
                "methodName": "xbe",
                "stackCaptureCount": 5
            },
            "addedAt": 1746450000000
        }
    ]
}
```

`installedHookId` n'est PAS persisté (volatile). À l'attach, tout est disarmed.

Le `DiskPluginStorage.set("hooks", arr)` qu'on a écrit en option 1 fait déjà tout le travail de durabilité (atomic write, cache mémoire, sanitisation).

---

## Error handling

| Cas | Comportement |
|-----|--------------|
| Class not found au moment de l'install | Notif erreur dans VSCode + tree garde le hook disarmed avec icône warning ⚠️ |
| Method not found | Idem |
| Frida agent disconnected | Tree montre tous les hooks comme disarmed grisés. Toggle bouton désactivé. |
| Hook spec invalide (template inconnu, force-return sans value) | Validate à `add` time, refuse + erreur. Un hook persisté foireux est skip à `reload()` avec warn console. |
| Storage corrompu (JSON cassé) | DiskPluginStorage l'a déjà : retourne map vide, repart à zéro au prochain set. |
| `installHook` côté agent throw | Le RPC propage ; le plugin attrape, marque disarmed, `vscode.window.showErrorMessage`. |
| Game crash / detach inattendu | `coreApi.profile.onDetach` → store.markAllDisarmed() → tree refresh. |

---

## Tests

### Unit (vitest, vscode-free)

- `HookStore` — add/update/remove/list, persistance round-trip via `DiskPluginStorage` mocké en mémoire (`fs` + tmp dir).
- `validateHookSpec` (pure) — couvre tous les templates et les invariants (force-return needs value, etc.).
- `HookEventBus` — multi-listener, dedup, backpressure ring buffer.

### Integration (vitest, vscode-free)

- Pas de tests d'agent (Frida sandbox impossible sans cible). Tests manuels via SMOKE-TEST.md.

### Smoke test (manuel)

Ajouter au `SMOKE-TEST.md` existant :
1. Add hook "log" sur `MapRenderer.cywh` via right-click sur Process Explorer
2. Vérifier tree montre installed avec icône verte
3. Naviguer dans le jeu → events arrivent dans Hook Log
4. Toggle off → uninstall agent-side, tree icon grisé
5. Detach → re-attach même build → hook réapparaît disarmed
6. Detach → re-attach build différent (faked via setting) → hook réapparaît dans le NOUVEAU profil seulement (pas de cross-bleed)

---

## File layout

```
dofus-app/vscode-extension/src/plugins/hooks/
├── index.ts                      # plugin activate(coreApi, ctx)
├── types.ts                      # HookSpec, StoredHook, HookEvent, HookTemplate
├── hook-store.ts                 # CRUD + persist
├── hook-event-bus.ts             # script.message → typed event stream
├── hooks-tree.ts                 # TreeDataProvider
├── commands.ts                   # registerHookCommands(...)
└── webviews/
    └── hook-log.ts               # Stream + Summary tabs

dofus-app/vscode-extension/test/plugins/hooks/
├── hook-store.test.ts
├── hook-spec-validation.test.ts
└── hook-event-bus.test.ts

src/rpc-agent/hooks.ts            # MODIFIED — adds installHook/revertHook/etc.
src/lib/hook.ts                   # MODIFIED — exposes lower-level primitives
src/lib/stack-trace.ts            # NEW — factor from sender.ts
```

`src/extension.ts` du Core gagne ~3 lignes pour `activateHooksPlugin(coreApi, ctx)`.

`package.json` extension manifest gagne :
- 1 view : `fridaHooks` dans `viewsContainers.activitybar.fridaToolkit`
- ~7 commandes
- 2 menus contextuels (right-click in Process Explorer)

---

## Open questions (à trancher pendant l'impl, pas bloquant pour la spec)

1. **Format d'export du Stream JSON** — ndjson ligne par ligne ou un array unique ? *Decision déférée à l'impl.*
2. **Couleurs de la webview** — utilise les CSS vars VSCode standard. Pas de palette custom à débattre.
3. **Filtre Stream — debounce ?** — 100ms probablement, à valider en feel test.

---

## Plan d'attaque (résumé pour `writing-plans`)

Découpage suggéré en sous-phases ; chaque sous-phase finit avec build clean + tests verts.

| Phase | Périmètre | Estimation |
|-------|-----------|-----------|
| 1 | Agent surface : `installHook/revertHook/listInstalledHooks/clearAllHooks` (templates `log` et `noop` only) + factor `lib/stack-trace.ts` | 0.5j |
| 2 | CoreApi + `frida-direct.ts` : exposer `onAgentMessage` | 0.25j |
| 3 | `HookStore` + persistance + tests | 0.5j |
| 4 | `HooksTreeProvider` + commandes Add/Toggle/Delete | 0.5j |
| 5 | `HookLogPanel` Stream tab (sans Summary) | 1j |
| 6 | Templates `force-return` + `log-stack` côté agent | 0.5j |
| 7 | Summary tab + filtres webview + export | 0.75j |
| 8 | Right-click intégration Process Explorer + edit command | 0.25j |
| 9 | SMOKE-TEST.md + bugfix pass + readme du plugin | 0.5j |

**Total** : ~5 jours, soit le ~1 semaine annoncé dans NEXT-SESSION.

---

## Risques / mitigations

| Risque | Probabilité | Mitigation |
|--------|-------------|------------|
| Le flux `send()` flood la webview à 1000+ hits/sec | Moyenne | Batching agent-side (envoyer toutes les 50ms en lot) + ring buffer + virtual list |
| `method.implementation` re-entrancy bug sur hot paths | Faible | Frida gère ; ajouter un guard `inHook` flag par hookId si besoin |
| Hook qui throw casse le jeu | Faible | Try/catch autour de chaque wrapper, send `error` event, original quand même invoqué si le wrapper est en `before`/`after` |
| User installe 50 hooks d'un coup → game freeze | Faible | Soft cap 20 hooks installed simultanément, warning au-delà |
| Plugin api change → break le plugin | N/A v1.1 | Le plugin est dans le même repo que le Core ; si la CoreApi change, on update le plugin dans le même commit |
