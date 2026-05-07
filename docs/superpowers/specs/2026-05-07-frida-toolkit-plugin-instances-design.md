# Frida IL2CPP Toolkit — Plugin Instances (v1.4) — Design Spec

> Énumère, lit, édite des **instances IL2CPP vivantes** côté jeu via `frida-il2cpp-bridge`. Les primitives agent existent déjà dans `src/rpc-agent/instance-ops.ts` (legacy pré-refactor) — v1.4 les valide, les expose via routes, et construit l'UI.

**Date** : 2026-05-07
**Branche cible** : `toolkit-core-v1` (continuité directe après v1.3 Deobfusc)
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q4 résumées plus bas)
**Dépendances** : Toolkit Core v1 + plugin Hooks v1.1 + plugin Network v1.2 + plugin Deobfusc v1.3

---

## TL;DR

Un plugin runtime qui :

1. **Énumère** les instances vivantes d'une classe via `Il2Cpp.gc.choose(klass)`, OR via hook d'une méthode tick (`captureViaHook`) pour les MonoBehaviours que le GC ne voit pas.
2. **Lit** tous les fields (scalaires, strings, enums, nested, arrays) — les nested et list-elements sont drillables : un click crée une nouvelle capture chainée (`captureFieldValue` / `captureListElement` / `captureMethodReturn`).
3. **Écrit** les fields scalaires (int / string / bool / enum) — autorisé seulement quand Read-Only OFF.
4. **Appelle** des méthodes arbitraires sur l'instance — confirmation modale obligatoire (risque de crash).
5. **Recettes** persistées per-profile : l'utilisateur sauvegarde une chaîne de captures sous un nom, replay one-click au prochain attach.
6. **History** in-memory : 50 dernières writes/calls, ephemeral, audit trail visible dans un panneau dédié.

**Out of scope v1.4** : édition d'arrays/lists (seulement read), édition de fields nested complexes, batch writes, scripts d'automation (v1.5+), undo automatique (impossible côté IL2CPP).

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Scope | **C — Full** : read + write + call methods + capture-via-hook |
| Q2 | UX | **C — Hybride** : page dédiée + bouton ⊙ Instances dans Class Detail (deep-link) |
| Q3 | Safety | **C — Toggle Read-Only global + confirmation modale UNIQUEMENT pour calls + History panel** |
| Q4 | Persistence | **B — Recettes sauvegardées per-profile, replay manuel** |

---

## Architecture

### Branche

`toolkit-core-v1` (continuité v1.2 + v1.3 + v1.4 cumulés). Pas de nouveau worktree, pas de fork.

### Côté agent

`src/rpc-agent/instance-ops.ts` existe déjà avec ~13 primitives :
- `capture(className, tickMethod, timeoutMs?)` — hook `tickMethod` une fois pour stealr `this`
- `captureViaGC(className, index?)` — `Il2Cpp.gc.choose(klass)[index]`
- `captureFieldValue(ownerKey, fieldName, asKey)` — chain dans un nested ref-typed field
- `captureListElement(ownerKey, listFieldName, index, asKey)` — drill dans un List<T>
- `captureMethodReturn(ownerKey, methodName, args, asKey)` — call et capture le retour
- `listInstances(className, max)` / `listCaptured()` — énumération
- `dumpInstance` / `dumpInstanceAsString` / `readField` / `readAllFields` — read
- `writeField(className, fieldName, value)` — write scalaire (avec coerce)
- `callInstance(className, methodName, args)` — call de méthode
- `readList(className, fieldName, limit)` — lecture de list backing array

**Travail v1.4 côté agent** : audit + adaptation des signatures (les méthodes legacy retournent souvent des strings concaténées — on veut du structuré). Ajouts mineurs si nécessaire (ex: `readFieldsStructured` qui retourne `FieldRead[]` au lieu de strings).

### Côté backend

| Fichier | Type | Responsabilité |
|---|---|---|
| `app/backend/core/instances/types.ts` | core types | `Recipe`, `RecipeStep`, `CapturedInstance`, `FieldRead`, `HistoryEntry`, `RecipeStore` schema |
| `app/backend/core/instances/instance-registry.ts` | core | Map<key, CapturedInstance> in-memory, `set/get/list/delete/clear` |
| `app/backend/core/instances/recipe-store.ts` | core | `Recipe[]` persisté via `DiskPluginStorage("instances")`, `onChange` event emitter |
| `app/backend/core/instances/history-store.ts` | core | Ring buffer 50 entries in-memory |
| `app/backend/core/instances/replay.ts` | core | `replayRecipe(recipe, agent, registry)` — exécute steps séquentiellement, accumule résultats |
| `app/backend/routes/instances.ts` | route | 12-15 endpoints (capture, read, write, call, recipes CRUD, history GET/clear) |
| `app/backend/session.ts` | wiring | Crée `instanceRegistry`, `recipeStore`, `historyStore` à l'attach. Clear `instanceRegistry` + `historyStore` au detach. Recipes survivent (persistées). |
| `app/backend/ws-bridge.ts` | wiring | Forward `instance-registry-changed`, `instance-history-changed`, `recipe-store-changed` |

### Côté frontend

| Fichier | Responsabilité |
|---|---|
| `app/frontend/pages/instances.ts` | Page 3-pane : sidebar captures, central viewer, history panel right |
| `app/frontend/components/instance-row.ts` | Une ligne de field — affichage typé, input inline pour scalaires, drill-down arrow pour nested/array |
| `app/frontend/components/instance-method-call-modal.ts` | Modale "Call method" avec form généré depuis `parameters[]` + confirmation |
| `app/frontend/components/recipe-modal.ts` | Modale liste/edit/replay des recettes |
| `app/frontend/components/capture-wizard-modal.ts` | Modale "+ New capture" 3-tabs (GC / Hook / chain) |
| `app/frontend/components/class-detail.ts` | + bouton `⊙ Instances` (deep-link `#/instances?class=...`) |
| `app/frontend/components/nav-icons.ts` | + icône Instances dans la nav principale |

### Plugin storage

`DiskPluginStorage("instances")` → fichier `<profile>/plugins/instances/recipe-store.json`. Schema version 1, atomic JSON writes (tmp + rename), corruption recovery via backup file (même pattern que serializer-config et labels).

### Layered separation

- **Agent** : primitives IL2CPP-aware, sans état persistent
- **Backend core** : état (registry, history, recipes), business logic (replay)
- **Backend routes** : transport HTTP + WS broadcast
- **Frontend** : présentation, interaction utilisateur

Aucun couplage frontend ↔ agent direct.

---

## Data model

### `RecipeStep` — discriminated union

```typescript
type RecipeStep =
    | { op: "captureViaGC"; className: string; index: number; asKey: string }
    | { op: "captureViaHook"; className: string; tickMethod: string; timeoutMs: number; asKey: string }
    | { op: "captureFieldValue"; ownerKey: string; fieldName: string; asKey: string }
    | { op: "captureListElement"; ownerKey: string; listFieldName: string; index: number; asKey: string }
    | { op: "captureMethodReturn"; ownerKey: string; methodName: string; args: unknown[]; asKey: string };
```

### `Recipe` — persisted

```typescript
interface Recipe {
    id: string;                  // uuid
    name: string;                // "PlayerCharacter + inventory"
    description?: string;
    steps: RecipeStep[];         // sequential; later steps may reference earlier asKey
    createdAt: string;           // ISO
    updatedAt: string;
    lastReplayedAt?: string;
    lastReplayStatus?: "ok" | "partial" | "failed";
}

interface RecipeStoreSchemaV1 {
    schemaVersion: 1;
    recipes: Recipe[];
}
```

### `CapturedInstance` — in-memory

```typescript
interface CapturedInstance {
    key: string;                  // user-defined ("player")
    className: string;            // IL2CPP class
    handle: string;               // hex address (display only)
    capturedAt: string;
    capturedVia: RecipeStep["op"];
    isAlive: boolean;             // best-effort, refreshed before each batch read
}
```

### `FieldRead` — read result

```typescript
interface FieldRead {
    name: string;
    typeName: string;
    kind: "scalar" | "string" | "enum" | "nested" | "array" | "null" | "unknown";
    preview: string;              // human-readable rendering
    rawValue?: string | number | boolean;  // for scalars (round-trip writes)
    enumNumeric?: number;         // when kind=enum, the underlying integer
    nestedClass?: string;         // when kind=nested, target class for drill-down
    arrayLength?: number;         // when kind=array
    isWritable: boolean;          // false for static / readonly / computed properties
}
```

### `HistoryEntry` — audit trail

```typescript
interface HistoryEntry {
    id: string;                   // uuid
    timestamp: string;
    action: "write" | "call";
    target: { instanceKey: string; member: string };
    before?: string;              // writes only
    after?: string;               // writes only
    callArgs?: unknown[];
    callResult?: string;
    success: boolean;
    error?: string;
}
```

**Justifications :**
- `RecipeStep` discriminé → chaque op explicite, pas de payload générique flou.
- `CapturedInstance.isAlive` est un check best-effort — la VM peut GC un objet entre deux interactions UI ; on probe le 1er field non-null avant chaque batch de read.
- `FieldRead.rawValue` permet à l'UI d'afficher un input pré-rempli pour les writes scalaires sans re-parser le `preview`.
- `HistoryEntry` n'est pas persisté — c'est un audit de session, pas un journal long-terme. Évincé par ring buffer 50.

---

## Backend engine

### `InstanceRegistry`

```typescript
class InstanceRegistry {
    private entries = new Map<string, CapturedInstance>();

    set(key: string, className: string, handle: string, via: RecipeStep["op"]): void;
    get(key: string): CapturedInstance | null;
    list(): CapturedInstance[];
    delete(key: string): void;
    clear(): void;
    onChange(cb: () => void): () => void;
}
```

Vit le temps d'une session. Wired dans `Session._doAttach` (créé) et `Session.handleDetach` (clear). Les handles IL2CPP sont valables uniquement le temps que la VM tourne — pas de persistance possible.

### `RecipeStore`

```typescript
class RecipeStore {
    constructor(storage: DiskPluginStorage);  // loads "recipe-store.json"
    list(): Recipe[];
    get(id: string): Recipe | null;
    add(name: string, steps: RecipeStep[], description?: string): Recipe;
    update(id: string, patch: Partial<Pick<Recipe, "name" | "description" | "steps" | "lastReplayedAt" | "lastReplayStatus">>): void;
    delete(id: string): void;
    onChange(cb: () => void): () => void;
}
```

`DiskPluginStorage(profile, "instances")`. Schema v1. Atomic writes, corruption recovery via backup.

### `HistoryStore`

```typescript
class HistoryStore {
    private entries: HistoryEntry[] = [];
    private static readonly MAX = 50;

    append(entry: HistoryEntry): void;        // evicts oldest beyond MAX
    list(): HistoryEntry[];                    // most recent first
    clear(): void;
    onChange(cb: () => void): () => void;
}
```

Standalone in-memory class. Survit le temps de la session. Pas de fichier disque — éphémère par design.

### Replay flow — `replayRecipe(recipe, agent, registry)`

```
for step in recipe.steps:
    if step references an asKey not yet present in registry: error step
    try:
        result = agent.{step.op}(...step.args)
        registry.set(step.asKey, result.className, result.handle, step.op)
        push step result { ok: true, summary }
    catch err:
        push step result { ok: false, error: err.message }
        # best-effort: continue with remaining steps
return { steps: stepResults, finalStatus: "ok" | "partial" | "failed" }
```

`finalStatus = "ok"` si tous steps OK, `"partial"` si ≥ 1 OK et ≥ 1 failed, `"failed"` si tous failed.

### Read flow

`POST /api/instances/:key/read-fields`
1. Backend vérifie `registry.get(key)` existe
2. Probe `isAlive` via read 1-field (try/catch)
3. Si alive : agent `readAllFieldsStructured(key)` retourne `FieldRead[]`
4. Si dead : retourne `{ alive: false, fields: [] }` — UI affiche un warning

### Write flow

`POST /api/instances/:key/write-field { fieldName, value }`
1. Backend check `registry.get(key)` + global flag `readOnly === false`
2. Snapshot `before` via read 1-field (`readField`)
3. Agent `writeField(key, fieldName, value)` (avec coerce dans l'agent)
4. Snapshot `after`
5. Push `HistoryEntry { action: "write", before, after, success: true }` (ou `success: false` + `error`)
6. Broadcast WS `instance-history-changed`
7. Retourne `{ before, after }`

### Call flow

`POST /api/instances/:key/call { methodName, args }`
1. Backend check `registry.get(key)` + `readOnly === false` (read-only bloque les calls aussi par sécurité)
2. Agent `callInstance(key, methodName, coercedArgs)`
3. Push `HistoryEntry { action: "call", callArgs, callResult, success }` 
4. Broadcast WS
5. Retourne `{ result }`

L'UI demande confirmation modale AVANT d'envoyer la requête — backend ne re-confirme pas.

### Read-Only flag

State global per-session, in-memory dans `Session` (`readOnly: boolean = true` par défaut). Mutable via `POST /api/instances/read-only { enabled: boolean }`. Broadcast `read-only-changed`. Toutes les routes mutantes vérifient le flag avant d'agir → `403 { error: "read-only mode active" }` sinon.

---

## Routes

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/instances/list` | — | `{ instances: CapturedInstance[] }` |
| POST | `/api/instances/capture` | `RecipeStep` | `{ key: string, summary: string }` |
| DELETE | `/api/instances/:key` | — | `{ ok: true }` |
| POST | `/api/instances/:key/read-fields` | — | `{ alive: boolean, fields: FieldRead[] }` |
| POST | `/api/instances/:key/write-field` | `{ fieldName, value }` | `{ before, after }` (ou 403) |
| POST | `/api/instances/:key/call` | `{ methodName, args }` | `{ result }` (ou 403) |
| GET | `/api/instances/recipes` | — | `{ recipes: Recipe[] }` |
| POST | `/api/instances/recipes` | `{ name, steps, description? }` | `{ recipe: Recipe }` |
| PUT | `/api/instances/recipes/:id` | `Partial<Recipe>` | `{ recipe: Recipe }` |
| DELETE | `/api/instances/recipes/:id` | — | `{ ok: true }` |
| POST | `/api/instances/recipes/:id/replay` | — | `{ steps: StepResult[], finalStatus: "ok"\|"partial"\|"failed" }` |
| GET | `/api/instances/history` | — | `{ entries: HistoryEntry[] }` |
| DELETE | `/api/instances/history` | — | `{ ok: true }` |
| GET | `/api/instances/read-only` | — | `{ enabled: boolean }` |
| POST | `/api/instances/read-only` | `{ enabled }` | `{ enabled: boolean }` |

---

## UI page Instances

### Layout

```
┌─ TOOLBAR ──────────────────────────────────────────────────────────────────┐
│ [+ Capture]  [▶ Recipes]   [☑ Read-Only]   [↻ Refresh]    │ History (12) │
├─────────────────────────────┬──────────────────────────────┬───────────────┤
│ SIDEBAR (300px)             │ CENTRAL VIEWER               │ HISTORY (320) │
│                             │                              │               │
│ Captured Instances (4)      │ player → PlayerCharacter@5af │ 14:23:11      │
│                             │                              │  [WRITE]      │
│ [☉] player                  │ ─ Fields ─ (52)              │  player.health│
│      PlayerCharacter@5af    │                              │   100 → 9999  │
│                             │ health   int    100  [edit]  │               │
│ [○] inventory               │ name     string "Toto"       │ 14:23:05      │
│      Inventory@7c1          │ mapId    int    8024  [edit] │  [CALL]       │
│                             │ ▸ inventory (Inventory)      │  player.Heal()│
│ [○] currentMap              │ ▸ stats     (PlayerStats)    │   → void      │
│      DungeonMap@9f0         │ effects  array [3 items] ▸   │               │
│                             │ kind     enum   2 [Mage]     │ ...           │
│ [○] item0                   │                              │               │
│      ItemRef@2bb            │ ─ Methods ─ (call)           │               │
│                             │                              │               │
│ [+ New capture]             │ Heal()                  [⊳]  │               │
│ [▶ From recipe]             │ TakeDamage(int amount)  [⊳]  │               │
│                             │ ...                          │               │
└─────────────────────────────┴──────────────────────────────┴───────────────┘
```

### Sidebar (left, 300px)

Liste des `CapturedInstance` du registry. Click = switch active. `[☉]` = active, `[○]` = inactive. Right-click → `Rename | Copy handle | Remove`. Footer : `+ New capture` (modale wizard) et `▶ From recipe` (modale liste recipes).

### Central viewer

**Fields section** : tableau scrollable, une ligne par field.
- **Scalaire writable + Read-Only OFF** → input inline + bouton `Save` qui appelle `/write-field`. Sur succès, ligne flashe vert 1s.
- **`nested`** → bouton `▸` qui ajoute une ligne au sidebar (capture ce nested via `captureFieldValue` avec `asKey = ${activeKey}.${fieldName}`) et switch dessus.
- **`array`** → bouton `▸` ouvre une mini-modale "Pick index" puis crée capture via `captureListElement`.
- **`enum`** → input is a `<select>` avec les enum members listés (résolus via labels.ts si labels existent), submit écrit la valeur numérique.

**Methods section** : tableau, une ligne par méthode non-static.
- Bouton `⊳` ouvre modale "Call method" : forme générée à partir des `parameters[]`, chaque param a son input typé. Submit → confirmation modale `Calling .Heal() — risk: client may crash. Continue? [Cancel] [Call]` → POST `/call`. Affiche le résultat dans la History panel.

### History panel (right, ~320px)

Liste descendante des `HistoryEntry`. Chaque row :
- Timestamp + tag `[WRITE]` ou `[CALL]`
- `instanceKey.member`
- Pour write : `before → after`
- Pour call : `(args) → result`
- Click sur une entrée = scroll le central viewer sur ce field/method (orientation visuelle)

Clear button au header. Pas de filtres v1 (50 entries max, on scroll).

### Modales

**`+ New capture` modale** : 3 onglets selon op-type
- **`via GC`** : `className` (autocomplete via `searchClasses`), `index` (default 0), `asKey` (auto-rempli `className.toLowerCase()`)
- **`via Hook`** : `className`, `tickMethod` (dropdown alimenté par `listClassMembers`), `timeoutMs` (default 10000), `asKey`
- **`chain`** : `ownerKey` (dropdown des captures existantes), choix entre `field` (`fieldName`) / `list element` (`fieldName + index`) / `method return` (`methodName + args`), `asKey`

Submit → POST `/capture` → registry update → broadcast WS → page re-render. Si succès, switch active sur la nouvelle capture.

**`Recipes` modale** : liste les recipes existantes avec actions `Replay | Edit | Delete`. Bouton `+ Save current as recipe` qui prend l'historique actuel des captures de la session et le sérialise en `Recipe`.

### Entry point depuis Class Detail

`app/frontend/components/class-detail.ts` gagne un bouton `⊙ Instances` à côté de `Hook | Trace | ⇄ Net`. Click → `location.hash = #/instances?class=<className>` → page Instances s'ouvre avec la modale `+ New capture` pré-ouverte sur l'onglet `via GC`, `className` pré-rempli.

### WebSocket events

- `instance-registry-changed` (re-render sidebar)
- `instance-history-changed` (re-render history panel)
- `recipe-store-changed` (re-render recipes modale si ouverte)
- `read-only-changed` (re-render toolbar toggle)

Émis par les routes après chaque mutation, broadcastés par `ws-bridge.ts`.

---

## Tests

### Backend pur (vitest)

**`app/test/backend/core/instances/instance-registry.test.ts`**
- ✓ `set` puis `get` retourne l'entrée
- ✓ `set` deux fois sur même key écrase
- ✓ `delete` retire, `get` retourne null
- ✓ `clear` vide tout
- ✓ `onChange` émet sur set/delete/clear

**`app/test/backend/core/instances/recipe-store.test.ts`**
- ✓ `add` persiste sur disque (lecture du fichier vérifie le contenu)
- ✓ `update` mute champs et flush
- ✓ `delete` retire et flush
- ✓ Reload depuis disque restaure l'état
- ✓ `onChange` émet sur add/update/delete
- ✓ Schema corrompu → backup + reset propre

**`app/test/backend/core/instances/history-store.test.ts`**
- ✓ `append` jusqu'à 50 entries → `list` ordonné par timestamp desc
- ✓ Au 51ème append, le plus ancien est évincé
- ✓ `clear` vide

**`app/test/backend/core/instances/replay.test.ts`**
- ✓ Replay d'une recipe avec 3 steps mock-agent appelle l'agent dans l'ordre
- ✓ Step qui échoue n'arrête pas la replay → `lastReplayStatus = "partial"`
- ✓ Step référençant un `asKey` inexistant retourne erreur structurée
- ✓ Tous les `setCaptured` aboutissent dans `InstanceRegistry`

### Backend routes (supertest)

**`app/test/backend/routes-instances.test.ts`**
- ✓ `POST /api/instances/capture` (5 variants : GC, Hook, FieldValue, ListElement, MethodReturn)
- ✓ `GET /api/instances/list` retourne le registry
- ✓ `POST /api/instances/:key/read-fields` retourne `FieldRead[]`
- ✓ `POST /api/instances/:key/write-field` quand Read-Only OFF → 200 + history entry créé
- ✓ `POST /api/instances/:key/write-field` quand Read-Only ON → 403
- ✓ `POST /api/instances/:key/call` quand Read-Only OFF → 200 + history entry
- ✓ `POST /api/instances/:key/call` quand Read-Only ON → 403
- ✓ `GET/POST/PUT/DELETE /api/instances/recipes` (liste, add, update, delete)
- ✓ `POST /api/instances/recipes/:id/replay` → simule l'exécution séquentielle, retourne le détail step-by-step
- ✓ `GET /api/instances/history` retourne les 50 derniers
- ✓ `DELETE /api/instances/history` clear
- ✓ `GET/POST /api/instances/read-only` toggle

### Frontend (vitest happy-dom)

**`app/test/frontend/pages/instances.test.ts`**
- ✓ Render empty state (no captures) avec boutons `+ New capture` et `▶ From recipe`
- ✓ Render avec 3 captures dans sidebar, click switch active
- ✓ Read-Only ON → inputs writable sont disabled
- ✓ Read-Only OFF + click Save sur un field → POST `/write-field` avec bon payload
- ✓ Click sur méthode → modale call → confirm → POST `/call`
- ✓ History panel re-render sur `instance-history-changed` WS

### Agent (smoke) — manuel

Sur Dofus :
1. Attach + naviguer vers Process Explorer + ouvrir une classe (`PlayerCharacter` ou équivalent)
2. Click `⊙ Instances` → page Instances ouverte avec wizard pré-rempli
3. Submit GC capture → instance dans sidebar, fields lisibles
4. Drill-down dans un nested (`Inventory`) → nouvelle entrée sidebar
5. Toggle Read-Only OFF, modifier une valeur scalaire (ex: kamas/health) → vérifier impact in-game
6. Sauvegarder une recette ("Player + inventory") → relancer le jeu → replay one-click
7. Tester un `callInstance` sur une méthode connue inoffensive (ex: getter)

### Cible

~191 tests v1.3 baseline + ~35 nouveaux backend + ~6 frontend = **~232 tests verts**.

---

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| **Crash client sur write/call** | Read-Only ON par défaut. Confirmation modale obligatoire pour calls. History permet de retracer exactly ce qui a été fait avant un crash. |
| **Instance GC'd entre deux reads** | `isAlive` probe avant chaque batch read. Si dead → marquer dans sidebar, l'utilisateur peut re-capture. |
| **Recipe replay fail (instance pas encore créée à l'attach)** | Replay best-effort : continue après step failed, retourne détail step-by-step. UI affiche les steps en erreur explicitement. L'utilisateur peut compléter manuellement. |
| **Dérapage trainer/cheat** | Read-Only par défaut. Bouton de toggle est visible. On documente clairement dans la README/UI les risques. Pas d'auto-trigger ; chaque action est explicite. |
| **Désync serveur Dofus sur write** | C'est le risque assumé. La History panel rend les actions traçables. Pas de mitigation côté toolkit (c'est le rôle du jeu de valider serveur-side). |
| **Coût mémoire registry** | Capped naturellement par usage humain (~10-30 captures max en pratique). Pas de cleanup auto, mais `clear()` au detach. |

---

## Out of scope v1.4

- Édition d'arrays/lists (read seulement)
- Édition de fields nested complexes (ref-types non-scalaires)
- Batch writes (un write à la fois)
- Scripts d'automation type "tick: heal if hp < 30%" (réservé v1.5+)
- Undo automatique (impossible côté IL2CPP)
- Filtres history avancés (basic ring buffer scroll suffit)
- Export/import de recettes entre profiles (DiskPluginStorage gère déjà la persistance par-profile, l'export inter-profile est nice-to-have)
- Multi-instance batch ops (read N instances de la même classe en parallèle)

---

## Critères d'acceptation v1.4

- ✅ ~232 tests verts (191 baseline + ~41 nouveaux)
- ✅ Build vite + tsc clean
- ✅ Smoke-test Dofus :
  - GC capture fonctionne sur une classe statique connue
  - Hook capture fonctionne sur un MonoBehaviour invisible au GC
  - Drill-down chain ≥ 3 niveaux fonctionne (player → inventory → items[0])
  - Write d'un scalaire visible in-game (ex: kamas modifie l'affichage)
  - Recipe save → restart game → replay one-click → tous les captures restaurés
  - History panel reflète les writes/calls effectuées
  - Read-Only toggle bloque writes et calls
- ✅ Pas de régression sur v1.2 Network ni v1.3 Migrations
- ✅ Bouton `⊙ Instances` dans Class Detail deep-link vers la page avec wizard pré-rempli
