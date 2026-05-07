# Frida IL2CPP Toolkit — Game Plugin System (v1.5) — Design Spec

> Système de plugins-jeu bundlé à build-time. Chaque plugin = un dossier `app/plugins/<id>/` qui contient un manifest, ses pages frontend, et ses routes backend. Vite découvre les plugins via `import.meta.glob`, le backend via un registre explicite. Premier consommateur : plugin Dofus (scaffolding only — la mini-map elle-même est un sub-project séparé).

**Date** : 2026-05-07
**Branche cible** : à brancher fresh depuis `master` (ex: `feat/v1.5-game-plugins`)
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q4 résumées plus bas)
**Dépendances** : Toolkit Core v1 + Plugin Scripts v1.4 (déjà mergés sur master)

---

## TL;DR

Aujourd'hui, ajouter une feature jeu-spécifique au toolkit (genre une mini-map Dofus) demande de modifier `main.ts`, `nav-icons.ts`, `server.ts`, et de coller du code spécifique-jeu dans le code générique. C'est ce qu'on évite.

v1.5 introduit un système de **Game Plugins** :
- Un plugin = un dossier `app/plugins/<id>/` avec `manifest.ts`, `pages/`, `routes/`
- Le manifest déclare : `id`, `displayName`, `gameName` (matché contre `profile.gameName`), icône nav, lazy import de la root page, identifiant de la mount-fn backend
- Le frontend découvre tous les manifests via vite glob au build, ajoute UNE icône nav par plugin (groupe séparé)
- Click sur l'icône → mount la root page si le profile attaché matche le `gameName`, sinon affiche un notice "attach to <gameName> first"
- La root page gère ses propres sub-tabs (Map | Items | State…) via le hash URL — le toolkit ne sait rien de la sub-structure
- Le backend mount les routes du plugin via un registre explicite (`PLUGIN_BACKENDS` dans `app/backend/plugins/registry.ts`) — 1 ligne par plugin

Premier livrable de cette spec : le système + le **scaffolding** du plugin Dofus (manifest + pages vides + route stub `/api/dofus/map/current`). Les features Dofus (mini-map, items, state) sont des sub-projects suivants.

**Out of scope v1.5** : agent code par-plugin, lifecycle hooks, hot-reload sans restart, dynamic load depuis `<profile>/`, plugin settings page, multi-icône par plugin.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Ordre d'attaque | **Custom (user)** — un plugin par jeu avec connexions au toolkit (API). Premier livrable = système + scaffolding plugin Dofus, mini-map livrée séparément après. |
| Q2 | Déploiement | **A — Bundlé à build-time** dans `app/plugins/<id>/`. Vite glob discovery côté frontend, registre explicite côté backend. |
| Q3 | Surface plugin v1 | **Frontend pages + Backend HTTP routes**. Pas d'agent code Frida par-plugin, pas de lifecycle hooks. |
| Q4 | Intégration nav | **A — Une icône nav par plugin**, le plugin gère ses sub-tabs en interne. |
| Q5 | Activation | **A — Icône toujours visible, page conditionnelle** : si le profile ne matche pas le `gameName`, render un notice. |

---

## Architecture

10 fichiers ajoutés ou modifiés.

| Fichier | Rôle |
|---|---|
| `app/frontend/core/plugin-types.ts` | Types `GamePlugin`, `PluginPageModule`, `PluginPageContext` ; factory `defineGamePlugin` |
| `app/frontend/core/plugin-host.ts` | Discovery via `import.meta.glob("../../plugins/*/manifest.ts", {eager:true})` ; expose `listPlugins()`, `getPlugin(id)` ; collision detection (warn+skip sur duplicate id) |
| `app/frontend/components/nav-icons.ts` | **Modifié** — append plugin icons après les built-ins, avec un séparateur visuel (`<div class="nav-sep">`) |
| `app/frontend/main.ts` | **Modifié** — `mountPage` fallback sur `getPlugin(tab)` ; nouvelle helper `mountPluginPage` qui check le profile et load la root page lazy ; subscribe `profile-attached`/`profile-detached` re-mount le plugin si actif |
| `app/frontend/components/plugin-not-attached.ts` | Nouveau composant : render le notice "this plugin requires attaching to <gameName>" + bouton qui ouvre le process picker |
| `app/backend/plugins/registry.ts` | Nouveau fichier : `PLUGIN_BACKENDS: PluginBackend[]` — 1 entrée par plugin avec `{ id, mount }` |
| `app/backend/server.ts` | **Modifié** — boucle sur `PLUGIN_BACKENDS`, call `plugin.mount(app, { session })` dans un try/catch isolé |
| `app/plugins/dofus/manifest.ts` | Premier plugin : `defineGamePlugin({ id: "dofus", gameName: "dofus", navIcon: "crown", rootPage: () => import("./pages/root") })` |
| `app/plugins/dofus/pages/root.ts` | Page racine Dofus : sub-tabs Map / Items / State (placeholder), parse `currentSubTab` depuis le ctx |
| `app/plugins/dofus/routes/index.ts` | Route stub `/api/dofus/map/current` (delegates to `instances` + `agentCall`) |

Pas d'agent Frida modifié. Pas de schémas profile changés. Le `<profile>` filesystem reste identique.

---

## Data model

### `app/frontend/core/plugin-types.ts`

```ts
export interface GamePlugin {
    id: string;                     // unique slug, ex: "dofus"
    displayName: string;            // ex: "Dofus"
    gameName: string;               // matches profile.manifest.gameName
    navIcon: string;                // key from icons.ts catalog
    rootPage: () => Promise<{ default: PluginPageModule }>;
}

// Backend mount is wired by id matching: PLUGIN_BACKENDS[i].id === GamePlugin.id.
// No explicit cross-reference field — the backend registry is the source of truth for which
// plugins have backend routes, and the validation step at boot warns on mismatches.

export interface PluginPageModule {
    /** Mount the plugin's root page into `host`. */
    mount(host: HTMLElement, ctx: PluginPageContext): void;
}

export interface PluginPageContext {
    profile: { gameName: string; buildId: string } | null;
    setSubTab(key: string): void;        // updates location.hash
    currentSubTab: string | null;
}

export function defineGamePlugin(p: GamePlugin): GamePlugin {
    return p;
}
```

### `app/backend/plugins/registry.ts`

```ts
import type { Express } from "express";
import type { Session } from "../session";
import * as dofusRoutes from "../../plugins/dofus/routes";

export interface PluginBackend {
    id: string;
    mount: (app: Express, deps: PluginBackendDeps) => void;
}

export interface PluginBackendDeps {
    session: Session;
}

export const PLUGIN_BACKENDS: PluginBackend[] = [
    { id: "dofus", mount: dofusRoutes.mount },
];
```

Un seul tableau modifiable à la main. Pas de filesystem scan, pas de manifest backend séparé. Quand un nouveau plugin arrive, on ajoute 1 import + 1 entrée.

---

## Discovery & lifecycle

### Frontend discovery (build-time)

```ts
// app/frontend/core/plugin-host.ts
const modules = import.meta.glob<{ default: GamePlugin }>(
    "../../plugins/*/manifest.ts",
    { eager: true },
);

const PLUGINS = new Map<string, GamePlugin>();
for (const m of Object.values(modules)) {
    const p = m.default;
    if (BUILTIN_TABS.has(p.id)) {
        console.warn(`[plugin-host] plugin id '${p.id}' collides with built-in tab, skipping`);
        continue;
    }
    if (PLUGINS.has(p.id)) {
        console.warn(`[plugin-host] duplicate plugin id '${p.id}', skipping`);
        continue;
    }
    PLUGINS.set(p.id, p);
}
```

`BUILTIN_TABS` = `Set` des 7 tabs built-in (`explorer`, `hooks`, `network`, `bookmarks`, `migrations`, `instances`, `scripts`). Validation défensive.

Le glob est `eager: true` → tous les manifests sont évalués au build, intégrés dans le bundle. Les `rootPage: () => import(...)` restent lazy (vite les code-split en chunks séparés).

### Frontend mount flow

```
User clicks plugin nav icon
        ↓
onSelect(plugin.id) → location.hash = "#/<plugin.id>" + mountPage(plugin.id)
        ↓
mountPage("dofus") fallback to getPlugin("dofus")
        ↓
mountPluginPage(host, plugin):
    - Read currentProfile() (cached from refreshProfile())
    - If profile.gameName !== plugin.gameName:
        → renderPluginNotAttached(host, {plugin, currentGameName})
    - Else:
        → await plugin.rootPage() → page module loaded (lazy)
        → page.mount(host, {profile, currentSubTab, setSubTab})
```

**Note d'API breaking** : `mountPage` devient `async function mountPage(tab: NavTab): Promise<void>` (à cause du `await plugin.rootPage()`). Tous les call sites existants (sync) restent compatibles si appelés via `void mountPage(tab)` — fire-and-forget. Aucun appelant existant dans `main.ts` ne dépend de la valeur de retour. Petit changement à propager dans le hashchange listener et le boot.

### Re-render on profile change

`main.ts` already subscribes to `profile-attached` / `profile-detached`. Add: when these fire AND the current tab is a plugin id, re-call `mountPage(currentTab)` so the page switches between notice and real page automatically.

```ts
subscribe("profile-attached", () => { void refreshProfile(); maybeRemountPlugin(); });
subscribe("profile-detached", () => { void refreshProfile(); maybeRemountPlugin(); });

function maybeRemountPlugin(): void {
    // Same parsing pattern as the existing hashchange handler in main.ts.
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    if (getPlugin(tab)) void mountPage(tab);
}
```

`BUILTIN_TABS` est défini une seule fois dans `plugin-types.ts` (export `const BUILTIN_TABS: ReadonlySet<string>`) et consommé par `nav-icons.ts` et `plugin-host.ts`. Pas de duplication.

### Backend mount flow

In `server.ts`, after all built-in mounts:

```ts
for (const plugin of PLUGIN_BACKENDS) {
    try {
        plugin.mount(app, { session });
        console.log(`[plugins] mounted backend for '${plugin.id}'`);
    } catch (err) {
        console.error(`[plugins] failed to mount backend for '${plugin.id}':`, err);
    }
}
```

Per-plugin try/catch : un plugin défaillant ne tue pas le serveur. Convention : routes du plugin préfixées par `/api/<plugin-id>/...`.

---

## Sub-tab navigation

Le toolkit ne définit pas de standard pour les sub-tabs. Convention :
- URL hash : `#/<plugin-id>?sub=<key>` (ex: `#/dofus?sub=map`)
- `mountPluginPage` parse `?sub=<key>` du hash, passe en `ctx.currentSubTab`
- Le plugin appelle `ctx.setSubTab("items")` → écrit `#/dofus?sub=items` → `hashchange` → re-mount root page → ctx.currentSubTab="items" → la page rend la sub-page Items

Le plugin peut ignorer les sub-tabs entièrement s'il n'a qu'une seule page. Pas de boilerplate forcé.

**Exemple `app/plugins/dofus/pages/root.ts`** (squelette) :

```ts
import type { PluginPageModule, PluginPageContext } from "../../../frontend/core/plugin-types";

const SUBS = ["map", "items", "state"] as const;
type Sub = typeof SUBS[number];
const DEFAULT_SUB: Sub = "map";

const mod: PluginPageModule = {
    mount(host, ctx) {
        const sub = (ctx.currentSubTab && (SUBS as readonly string[]).includes(ctx.currentSubTab)
            ? ctx.currentSubTab
            : DEFAULT_SUB) as Sub;

        host.innerHTML = `
            <div style="display:flex;flex-direction:column;flex:1">
                <div class="dofus-subnav" style="display:flex;gap:8px;padding:8px;border-bottom:1px solid #333">
                    ${SUBS.map((s) => `
                        <button data-sub="${s}" style="${s === sub ? "background:#1e3a8a;color:#fff" : ""}">${s}</button>
                    `).join("")}
                </div>
                <div data-testid="dofus-sub-host" style="flex:1;overflow:auto;padding:12px"></div>
            </div>
        `;

        host.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((btn) => {
            btn.addEventListener("click", () => ctx.setSubTab(btn.dataset.sub!));
        });

        const subHost = host.querySelector<HTMLElement>("[data-testid='dofus-sub-host']")!;
        subHost.innerHTML = `<p style="color:#888">Dofus plugin: ${sub} sub-page (placeholder)</p>`;
    },
};

export default mod;
```

Pour v1.5 toutes les sub-pages affichent un placeholder. La mini-map (sub-projet suivant) remplace le placeholder de `map` par du vrai code.

---

## API & contracts

### Frontend API exposée aux plugins

Un plugin frontend a accès, via les imports relatifs habituels, à :

- `app/frontend/core/api` — client HTTP du toolkit (`api.getInstances()`, `api.getProfile()`, etc.)
- `app/frontend/core/ws` — `subscribe(eventType, handler)` pour les WS events
- `app/frontend/core/icons` — catalogue d'icônes SVG
- `fetch("/api/<plugin-id>/...")` — pour appeler ses propres routes backend

Pas d'API "plugin SDK" formelle pour v1 — le plugin est juste du code TS qui vit dans le repo. Si ça devient nécessaire (sandboxing futur), on extrait une API formelle.

### Backend API exposée aux plugins

Les routes du plugin reçoivent `(app: Express, deps: PluginBackendDeps)` avec :

- `deps.session: Session` — accès à toutes les méthodes publiques de `Session` :
  - `instanceRegistry()`, `hookStore()`, `frameStore()`, `recipeStore()`, `historyStore()`, `scriptLoader()`, `scriptRunner()`
  - `fridaClient.call(method, args)` pour les RPC agent
  - Subscribe aux events session via `session.on(...)`

Convention :
- Préfixer toutes les routes par `/api/<plugin-id>/...`
- 503 si pas attaché (`session.instanceRegistry()` retourne null)
- 500 sur exceptions (catch + JSON error)

### Exemple de route Dofus (`app/plugins/dofus/routes/index.ts`)

```ts
import type { Express } from "express";
import type { PluginBackendDeps } from "../../../backend/plugins/registry";

export function mount(app: Express, deps: PluginBackendDeps): void {
    app.get("/api/dofus/map/current", async (_req, res) => {
        const reg = deps.session.instanceRegistry();
        if (!reg) { res.status(503).json({ error: "not attached" }); return; }
        try {
            const playerMgr = reg.list().find((c) => c.className === "PlayerManager" && c.isAlive);
            if (!playerMgr) { res.status(404).json({ error: "PlayerManager not captured yet" }); return; }
            const mapId = await deps.session.fridaClient.call(
                "readField", [playerMgr.className, playerMgr.handle, "currentMapId"],
            );
            res.json({ mapId });
        } catch (err) {
            res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
```

---

## UI : nav avec plugins

```
┌────┐
│ 🟦 │ Process Explorer
│ 🪝 │ Hooks
│ 🌐 │ Network
│ ⭐ │ Bookmarks
│ 🔄 │ Migrations
│ 🎯 │ Instances
│ ▶  │ Scripts
│────│ ← séparateur visuel (1px ou gap)
│ 👑 │ Dofus  ← plugin
│ 🎮 │ TOF    ← futur autre plugin
└────┘
```

Le séparateur (`<div class="nav-sep">`) est juste un `8px` gap ou `1px` ligne. Pas de label "PLUGINS" — visible mais discret.

Quand le profile attaché est `dofus` → l'icône Dofus est en couleur normale + click ouvre la vraie page. Sinon → icône grisée (CSS class `.nav-icon.unmatched`) + click affiche le notice.

État "unmatched" est calculé au render : `profile?.gameName === plugin.gameName ? "matched" : "unmatched"`.

---

## Static assets (data dumps)

DataCenter dumps Dofus (~57k entries, 5-10 MB JSON) vivent sous `app/plugins/dofus/data/`. Servis via routes Express explicites :

```ts
app.get("/api/dofus/items", async (_req, res) => {
    const data = JSON.parse(await fs.readFile(
        path.join(__dirname, "../data/items.json"), "utf8",
    ));
    res.json(data);
});
```

Pour v1, lecture par-route (pas de cache, suffit pour 5-10 MB en dev). Si on veut servir des assets binaires (sprites, atlas) plus tard → ajouter `app.use("/plugins/dofus/static", express.static(...))` dans le mount du plugin.

Pas d'`express.static` global pour les plugins — chaque plugin gère ses statics dans son `mount(app, deps)`.

---

## Tests

Stratégie TDD vitest, ~20 nouveaux tests. Cible : ~349 tests verts (329 actuels + 20).

### `app/test/frontend/core/plugin-host.test.ts` (4)

- ✓ `listPlugins()` retourne tous les manifests découverts
- ✓ `getPlugin(id)` retourne le bon plugin / null si inconnu
- ✓ Plugin avec `id` collidant avec un built-in tab → warn console + skip
- ✓ Deux plugins avec même `id` → second warn + skip

### `app/test/frontend/components/plugin-not-attached.test.ts` (3)

- ✓ Render avec `currentGameName: null` → message "no process attached"
- ✓ Render avec gameName mismatch → message "currently attached to X"
- ✓ Click bouton "Attach" → déclenche le process picker (spy/mock)

### `app/test/frontend/main-plugin-mount.test.ts` (4)

- ✓ `mountPage("dofus")` avec profile dofus attaché → la root page est mountée (mock `rootPage()`)
- ✓ `mountPage("dofus")` sans profile → `renderPluginNotAttached` appelé
- ✓ Sub-tab parsé correctement depuis hash `#/dofus?sub=items`
- ✓ Sur `profile-attached` event, si tab actif est un plugin → re-mount

### `app/test/backend/plugins/registry.test.ts` (3)

- ✓ Mount loop appelle chaque `plugin.mount(app, deps)` une fois
- ✓ Plugin qui throw au mount → catch isolé, autres plugins mountés quand même, console.error visible
- ✓ Routes du plugin Dofus accessible via supertest après mount

### `app/test/plugins/dofus/manifest.test.ts` (2)

- ✓ Manifest export valide (`id`, `gameName`, `displayName`, `navIcon`, `rootPage`)
- ✓ Lazy import `rootPage()` résout vers un module avec `mount` fonction

### `app/test/plugins/dofus/routes.test.ts` (4)

- ✓ `GET /api/dofus/map/current` sans attach → 503
- ✓ `GET /api/dofus/map/current` sans `PlayerManager` capturé → 404
- ✓ `GET /api/dofus/map/current` avec mock instance + agentCall → renvoie `{ mapId: ... }`
- ✓ Erreur agent → 500 avec error JSON

### Smoke (manuel)

- Build vite + tsc clean
- Lancer le toolkit, sans attach → icône Dofus visible mais grisée, click → notice "attach to dofus first"
- Attach à un process Dofus → icône passe en couleur normale, click → page Dofus avec sub-tabs Map/Items/State (placeholders)
- Click sur sub-tab → URL hash change, sous-page placeholder change
- API call `curl http://localhost:3001/api/dofus/map/current` → réponse selon état (503/404/200)

---

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| Vite glob ne matche pas si extension du manifest diffère (`.tsx`, etc.) | Pattern strict `manifest.ts` ; convention documentée dans le README plugin. Test du loader vérifie discovery. |
| Plugin id collide avec un built-in tab | Validation au boot : `BUILTIN_TABS.has(p.id)` → warn + skip. Test dédié. |
| Backend registry à maintenir à la main (1 ligne par plugin) | Documenté ; YAGNI auto-discovery pour v1. Si >10 plugins, on ajoute un script `gen-registry.js` qui scan `app/plugins/*/routes/index.ts`. |
| Plugin backend route throw au mount → serveur down | Try/catch par plugin dans `server.ts`. Plugin défaillant = console.error + skip ; serveur reste up. |
| Plugin frontend lazy import échoue (module manquant, syntax error) | Le `await plugin.rootPage()` rejette → catch dans `mountPluginPage` → render un error message dans le host (pas un crash UI). |
| Re-render sur attach/detach cause flicker | Re-mount uniquement si le tab actif est un plugin id. Built-in pages ne re-mount pas. Pas de flicker observé en pratique. |
| `import.meta.glob` pas supporté en mode test (vitest) | Vitest supporte `import.meta.glob` via le plugin vite. Si problème, mock `plugin-host` dans les tests qui ne testent pas le loader lui-même. |
| Plugin avec entry dans `PLUGIN_BACKENDS` mais aucun manifest frontend correspondant (ou inverse) | Désynchronisation. Au boot, le frontend logue les plugins sans backend (`/api/<id>/...` qui 404), le backend logue les `PLUGIN_BACKENDS` entries dont l'id n'est pas connu (l'agrégat des deux donne un warn complet). Acceptable v1. |

---

## Out of scope v1.5

- **Agent code Frida par-plugin** — RPCs custom restent dans `src/rpc-agent/` partagé. Si Dofus a besoin de `gbe-router`/`datacenter`, ils vivent dans l'agent global. v2 : `app/plugins/<id>/agent/` qui s'inject dans le bundle agent.
- **Lifecycle hooks** (`onAttach(profile)`, `onDetach(profile)`) — pour pre-loading auto. Workaround v1 : user fait ça via un Script.
- **Hot-reload de plugins sans restart** — bundlé build-time, donc nouveau plugin = restart `npm run dev` (vite HMR couvre les pages déjà chargées).
- **Dynamic load depuis `<profile>/plugins/`** — le drop-in friendly de Scripts ne s'applique pas aux plugins frontend pour v1.
- **Plugin Settings page** — toggles enable/disable manuels.
- **Multi-icône par plugin** — un plugin = une icône. Multi-pages se gère en sub-tabs.
- **Sub-tab persistence** (revenir au dernier sub-tab utilisé après reload) — le hash gère ça naturellement, pas besoin de store dédié.
- **Mini-map elle-même + features Dofus** — sub-projects suivants. Cette spec livre uniquement le système + scaffolding.
- **Sandboxing/CSP plugin frontend** — les plugins sont du code first-party, pas de sandbox.

---

## Critères d'acceptation v1.5

- ✅ ~349 tests verts (329 baseline + 20 nouveaux)
- ✅ Build vite + tsc clean (avec et sans `app/plugins/dofus/` présent)
- ✅ Plugin Dofus apparaît dans la nav (icône `crown`, séparateur visible)
- ✅ Click sur l'icône sans attach → notice "attach to dofus first" + bouton qui ouvre le picker
- ✅ Attach à un process Dofus (`gameName === "dofus"`) → l'icône passe en couleur normale, click → page Dofus avec sub-tabs placeholder
- ✅ Sub-tabs Map/Items/State accessibles, l'URL hash reflète la sub-tab active
- ✅ Backend route `GET /api/dofus/map/current` mountée, accessible via supertest
- ✅ Plugin défaillant (mock un crash au mount) → autres plugins + toolkit core fonctionnels
- ✅ Smoke manuel : flow nav vers le plugin sans attach → notice / attach → bascule auto sur la page
