# Frida IL2CPP Toolkit — Plugin Network (v1.2) — Design Spec

> Deuxième consommateur de la Plugin API du toolkit, après Hooks. Sniffer + decoder + rename de messages réseau IL2CPP, sans schéma externe (introspection live). Page dédiée avec Stream / Summary / Inspector par type.

**Date** : 2026-05-06
**Branche cible** : `toolkit-core-v1`
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q6 + variante détail A résumées plus bas)
**Dépendances** : Toolkit Core v1 + plugin Hooks v1.1 + migration localhost web app v2.0 (commit `5a041b3`)

---

## TL;DR

Un plugin de monitoring réseau intégré à l'app localhost qui :

1. **Auto-détecte** des patterns de sérialisation bien connus à l'attach (Google.Protobuf, MessagePack, Mirror NetworkWriter/NetworkReader) — propose ces points d'entrée comme entries pré-remplies. Si aucun trouvé, status "Disarmed — configure manually".
2. **Wizard manuel** (modal) pour désigner les méthodes Send/Receive personnalisées (cas Dofus / jeux obfusqués), via le Process Explorer existant.
3. **Hook au sérialiseur (objets C#)** plutôt qu'au socket — introspection IL2CPP live, pas de fichier `.proto` à charger. Les frames raw (byte[] au niveau socket) sont hors scope v1.2.
4. **Page dédiée** avec sidebar par type de message (S2C/C2S, sortés par count) et 3 onglets : Stream live, Summary stats, Inspector par type.
5. **Vue détail pretty-print indentée** (variante A) accessible depuis Stream et Inspector.
6. **Renames** classe/field passent par `labels.ts` existant — bénéficie automatiquement à Process Explorer + Hook Log.
7. **Persistance** : config sérialiseur per-profile via `plugin-storage` ; frames volatiles in-memory.

**Out of scope v1.2** : UDP, HTTP/REST, décodeurs externes (.proto/.desc), replay/inject, diff de frames, auto-arm.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Périmètre d'usage primaire | **C — Hybride** (raw → décodé après config sérialiseur) |
| Q2 | Couverture transport | **B — TCP + WebSocket** (UDP/HTTP puntés) |
| Q3 | Comment savoir quoi hooker | **C — Auto-detect + override manuel** (wizard) |
| Q4 | En mode décodé, on hook quoi | **B — Au sérialiseur, objets C# via `frida-il2cpp-bridge`** |
| Q5 | Vues offertes | **B — Stream + Summary + Inspector par type** |
| Q6 | Intégration UI dans l'app | **A — Page dédiée + sidebar par type** |
| Détail | Vue détail d'un message | **A — Pretty-print indenté avec barres verticales** |

---

## Goals / Non-goals

### Goals

- Sniffer **généraliste** pour n'importe quel jeu Unity IL2CPP, avec auto-detect plug-and-play sur Unity vanilla et escape hatch manuel pour les jeux obfusqués (Dofus, etc.).
- **Pas de fichier de schéma externe** : l'introspection IL2CPP live (via `frida-il2cpp-bridge`) suffit pour rendre les messages décodés.
- **Cohérence** avec le plugin Hooks (UI, persistence, anti-flood, auto-revert).
- **Renames intégrés** : changer le nom d'une classe/field dans le Network Monitor répercute partout (Explorer, Hook Log).
- **Inspector par type** = killer feature : voir 50 instances d'un même message en table avec highlights des variations field-by-field.

### Non-goals (v1.2)

- Pas de support UDP (pas de framing implicite).
- Pas de support HTTP/REST/UnityWebRequest (Fiddler/Charles font mieux).
- Pas de chargeur de schémas externes (.proto, .desc, .fbs).
- Pas de replay / inject / fuzz / mutate (c'est un sniffer, pas un éditeur).
- Pas de décrypte TLS in-process (l'introspection objet est en clair par construction).
- Pas de diff side-by-side entre 2 frames (l'Inspector visualise déjà les variations).
- Pas d'auto-arm au prochain attach (sécurité).
- Pas de persistance des frames cross-session (volatil par design).
- Pas de stream multi-process.

---

## Architecture

### Vue d'ensemble

```
┌──────────────────── Frida agent (src/rpc-agent/) ────────────────────┐
│  network.ts (NEW)                                                    │
│   • armNetworkCapture(config) — installs hooks per entry             │
│   • disarmNetworkCapture()                                           │
│   • walkFields(obj, MAX_DEPTH=2) → JSON-friendly preview             │
│   • on hook fire → send({type:"network-frame", direction, ...})      │
│   • anti-flood: 50 throws/sec → auto-revert this entry only          │
└────────────────────────────────────────────────────────────────────────┘
                              ▲ via existing FridaClient
                              │
┌──────────────── Backend (app/backend/core/network/) ─────────────────┐
│  types.ts             — NetworkFrame, MessageType, SerializerConfig  │
│  serializer-detector.ts — find well-known serializer entry points     │
│  serializer-config.ts — load/save (via plugin-storage)               │
│  frame-store.ts       — ring buffer 5000 + EventEmitter              │
│  type-aggregator.ts   — group-by-type, counts, lastSeen              │
│  event-bus.ts         — listen agent network-frame → push frame-store│
└────────────────────────────────────────────────────────────────────────┘
                              ▲ HTTP/WS
                              │
┌────────────── Backend routes (app/backend/routes/) ──────────────────┐
│  network.ts (NEW)                                                    │
│   GET    /api/network/frames?limit=&filter=&sinceId=                 │
│   GET    /api/network/types                                          │
│   GET    /api/network/types/:typeKey/instances?limit=                │
│   POST   /api/network/start                                          │
│   POST   /api/network/stop                                           │
│   GET    /api/network/serializer-config                              │
│   PUT    /api/network/serializer-config                              │
│   DELETE /api/network/frames                                         │
│  + WS broadcast: frame-added, network-auto-revert                    │
└────────────────────────────────────────────────────────────────────────┘
                              ▲ fetch / ws
                              │
┌──────────────── Frontend (app/frontend/) ────────────────────────────┐
│  pages/network.ts                — page composer                     │
│  components/network-monitor.ts   — layout 3-pane                     │
│  components/network-stream.ts    — onglet Stream                     │
│  components/network-summary.ts   — onglet Summary                    │
│  components/network-inspector.ts — onglet Inspector                  │
│  components/network-detail.ts    — vue détail pretty-print (A)       │
│  components/network-config.ts    — modal wizard de config            │
│  nav-icons.ts                    — add ⇄ "Network"                   │
└────────────────────────────────────────────────────────────────────────┘
```

### File layout (additions)

```
app/
├── backend/
│   ├── core/
│   │   └── network/                   ← NEW
│   │       ├── types.ts
│   │       ├── serializer-detector.ts
│   │       ├── serializer-config.ts
│   │       ├── frame-store.ts
│   │       ├── type-aggregator.ts
│   │       └── event-bus.ts
│   └── routes/
│       └── network.ts                 ← NEW
├── frontend/
│   ├── pages/
│   │   └── network.ts                 ← NEW
│   └── components/
│       ├── network-monitor.ts         ← NEW
│       ├── network-stream.ts          ← NEW
│       ├── network-summary.ts         ← NEW
│       ├── network-inspector.ts       ← NEW
│       ├── network-detail.ts          ← NEW
│       └── network-config.ts          ← NEW
└── test/
    └── backend/
        ├── core-network-frame-store.test.ts
        ├── core-network-type-aggregator.test.ts
        ├── core-network-serializer-config.test.ts
        ├── core-network-serializer-detector.test.ts
        └── routes-network.test.ts

src/
└── rpc-agent/
    └── network.ts                     ← NEW
```

---

## Components

### 1. Capture pipeline

**Au moment de l'attach**

```
1. Profile loaded → SerializerConfig is loaded (or created empty)
2. Si entries existent (auto ou manuelles précédentes) :
     → status: "Disarmed (config: <N entries>)"
3. Sinon (1er attach pour ce profil) :
     → run SerializerDetector — cherche des patterns de sérialisation bien connus (par classe/méthode dont on connaît le nom complet, donc résolu en < 50 ms via `findClassExact`) :
         - **Google.Protobuf** : si `Google.Protobuf.MessageExtensions` est présent, propose `WriteDelimitedTo` et `MergeDelimitedFrom` comme entries Send/Recv génériques.
         - **MessagePack** : si `MessagePack.MessagePackSerializer` présent, propose les overloads `Serialize` / `Deserialize` statiques.
         - **Mirror** (Unity MMO framework) : si `Mirror.NetworkWriter` et `Mirror.NetworkReader` présents, propose les méthodes `Write*` / `Read*` les plus utilisées.
         - **Photon Bolt / Mirage / NGO** : extensible via une table de patterns dans `serializer-detector.ts`.
     → si patterns trouvés : entries `source: "auto"` créées et persistées **disabled par défaut** (l'user les active explicitement après revue), status "Disarmed (N templates suggérés)"
     → si rien : status "Disarmed — configure manually" + toast d'invitation à utiliser le wizard

Note : auto-detect ne tente pas de hooker au niveau socket (`System.Net.Sockets.Socket`, `ClientWebSocket`) car ces hooks fournissent des `byte[]`, pas des objets C# décodés (cf. Q4=B). Pour les jeux dont la sérialisation est custom (Dofus, etc.), le wizard manuel est la voie principale.
```

**Pas d'auto-arm** (cohérent avec plugin Hooks). User clique `▶ Start` explicitement.

**Wizard manuel** (modal `network-config.ts`)

Déclenché par bouton `⚙ Configure` dans le footer sidebar du Network Monitor, ou par toast quand auto-detect a échoué.

Layout :
- Liste des entries existantes (auto + manuelles), groupées par source.
- Chaque entry affiche : direction, classe (label si rename, sinon obf), méthode, signature, paramIndex, statut (`✓ valid` / `❌ stale` / `⏸ disabled`).
- Actions par entry : Edit, Disable/Enable, Remove.
- Bouton `+ Add manual` ouvre un sub-flow inline :
  1. Direction (Send / Recv) — radio
  2. Class picker — input fuzzy via `searchClasses` RPC existant
  3. Method picker — liste via `listClassMembers` RPC existant
  4. Param index — auto (Send→0, Recv→"result"), modifiable
  5. Preview signature + bouton "Add"

À la sauvegarde, validation par RPC `validateSerializerEntry({className, methodName, signature})` côté agent. Entries invalides marquées `❌ stale`.

**Côté agent (`src/rpc-agent/network.ts`)**

```typescript
const installedNetworkHooks: Map<string, RevertHandle> = new Map();

export async function armNetworkCapture(config: SerializerConfig): Promise<{installed: number; failed: SerializerEntry[]}> {
  const failed: SerializerEntry[] = [];
  for (const entry of config.entries) {
    if (entry.disabled) continue;
    try {
      const klass = findClassExact(entry.className, entry.ns);
      const method = findMethodBySignature(klass, entry.methodName, entry.methodSignature);
      const original = method.implementation;
      const entryId = `${entry.className}.${entry.methodName}@${entry.direction}`;
      let throwsThisSecond = 0;
      let throwWindowStart = Date.now();
      
      method.implementation = function (...args: Il2Cpp.Parameter.Type[]) {
        const result = method.invoke(this, ...args);
        try {
          const messageObj = entry.direction === "send"
            ? args[entry.paramIndex ?? 0]
            : result;
          if (messageObj && isIl2CppObject(messageObj) && !messageObj.handle.isNull()) {
            const fields = walkFields(messageObj, MAX_DEPTH);
            send({
              type: "network-frame",
              direction: entry.direction === "send" ? "out" : "in",
              timestamp: Date.now(),
              typeKey: { ns: messageObj.class.namespace, className: messageObj.class.name },
              fields,
              truncated: fields.truncated,
            });
          }
        } catch (err) {
          // anti-flood
          const now = Date.now();
          if (now - throwWindowStart > 1000) { throwWindowStart = now; throwsThisSecond = 0; }
          throwsThisSecond++;
          if (throwsThisSecond > 50) {
            method.implementation = original;
            installedNetworkHooks.delete(entryId);
            send({ type: "network-auto-revert", entryId, reason: "throw-flood", detail: String(err) });
            return result;
          }
          send({ type: "network-frame-error", entryId, error: String(err) });
        }
        return result;
      };
      
      installedNetworkHooks.set(entryId, () => { method.implementation = original; });
    } catch (err) {
      failed.push(entry);
    }
  }
  return { installed: installedNetworkHooks.size, failed };
}

export function disarmNetworkCapture(): void {
  for (const revert of installedNetworkHooks.values()) {
    try { revert(); } catch {}
  }
  installedNetworkHooks.clear();
}
```

`walkFields(obj, depth)` itère sur `obj.class.fields`, sérialise chaque field en `FrameField` :
- Primitifs (int, long, float, bool, string) → `preview` direct, max 80 chars
- Enum → résolu en nom symbolique si possible, sinon valeur numérique
- `byte[]` → `"<N bytes: hex preview…>"`
- Nested (object IL2CPP) → si depth > 0, descend récursif ; sinon `"→ <ClassName> {…}"`
- Arrays / List<T> → `"[<count> items]"` + récursion sur les premiers éléments si depth > 0
- Null / handle null → `"null"`
- Toute autre erreur → `kind: "unknown"`, `preview: "<error>"`

Profondeur dure à 2 par défaut (configurable plus tard si besoin). Setter `truncated: true` quand on coupe.

### 2. Data model

```typescript
// app/backend/core/network/types.ts

export interface NetworkFrame {
  id: string;                      // monotonic, ex "f-00042"
  timestamp: number;               // epoch ms
  direction: "in" | "out";
  typeKey: TypeKey;                // identité obfusquée
  fields: FrameField[];
  truncated?: boolean;
}

export interface TypeKey {
  ns: string | null;
  className: string;               // obf
}

export interface FrameField {
  name: string;                    // obf
  kind: "int" | "long" | "float" | "bool" | "string" | "bytes"
      | "enum" | "nested" | "array" | "null" | "unknown";
  preview: string;                 // ≤ 80 chars
  children?: FrameField[];         // pour nested/array si depth ≥ 1
}

export interface MessageType {
  key: TypeKey;
  count: number;
  countByDirection: { in: number; out: number };
  lastSeenAt: number;
  observedFields: string[];        // union, dans l'ordre d'apparition
}

export interface SerializerConfig {
  schemaVersion: 1;
  entries: SerializerEntry[];
}

export interface SerializerEntry {
  source: "auto" | "manual";
  direction: "send" | "recv";
  className: string;               // obf
  ns: string | null;
  methodName: string;              // obf
  methodSignature: string;         // pour fingerprint au reload
  paramIndex?: number;             // Send: index dans args[] (default 0). Recv: ignoré (utilise result)
  disabled?: boolean;
  addedAt: string;                 // ISO
  lastValidatedAt?: string;        // ISO, pour traquer les stale
}
```

### 3. Persistence

| Donnée | Lieu | Schema |
|---|---|---|
| **NetworkFrame** (live) | In-memory ring buffer 5000 | `frame-store.ts` |
| **Renames classe/field** | `labels.ts` (existant, kind="class"/"field") | aucune nouvelle table |
| **Notes / bookmarks par type** | `annotations.ts` (existant) | aucune nouvelle table |
| **SerializerConfig** | `<profile>/plugins/network/serializer-config.json` via `plugin-storage` | nouveau fichier |

### 4. Frame store (ring buffer)

```typescript
export class FrameStore extends EventEmitter {
  private ring: (NetworkFrame | undefined)[] = new Array(5000);
  private head = 0;
  private size = 0;
  private nextId = 0;

  push(partial: Omit<NetworkFrame, "id">): NetworkFrame { /* assigns id, wraps */ }
  list(opts?: { limit?: number; sinceId?: string; filter?: string; direction?: "in" | "out" }): NetworkFrame[];
  byType(key: TypeKey, limit: number): NetworkFrame[];
  summary(): MessageType[];
  clear(): void;
  count(): number;

  // Events: "frame-added", "cleared"
}
```

### 5. Routes

`POST /api/network/start` :
- 409 si pas de profile attaché
- 400 si SerializerConfig vide
- Appelle `agent.invoke("armNetworkCapture", config)` → renvoie `{installed, failed}`

`POST /api/network/stop` :
- Appelle `agent.invoke("disarmNetworkCapture")` → 200

`GET /api/network/frames?limit=200&sinceId=f-00100&filter=Map&direction=in` :
- Délègue à `frameStore.list(opts)`

`GET /api/network/types` :
- `frameStore.summary()` → `{types: MessageType[]}`

`GET /api/network/types/:typeKey/instances?limit=50` :
- `typeKey` est encodé URL-safe : `<ns-or-empty>~<className>`
- Renvoie `{type: MessageType, frames: NetworkFrame[]}`

`GET /api/network/serializer-config` / `PUT /api/network/serializer-config` :
- CRUD sur le SerializerConfig persisté

`DELETE /api/network/frames` :
- `frameStore.clear()`

### 6. WebSocket events broadcast

Étendre `mountWsBridge` dans `app/backend/ws-bridge.ts` :
- `network-frame-added` : envoyé sur chaque push (throttled 50/s max — coalesce envois en sur-charge)
- `network-frames-cleared`
- `network-auto-revert` : forwarded depuis l'event-bus
- `network-armed` / `network-disarmed`

### 7. UI : Network Monitor (3-pane)

**Page** `pages/network.ts` compose :
- Sidebar gauche (240px, resizable comme Process Explorer) — composant `network-monitor-sidebar`
- Main area — composant `network-monitor` avec 3 onglets

**Sidebar**
- Filter input (substring sur typeName + label) — fait aussi office de filtre global pour Stream et Summary
- Section repliable `S2C (Receive) — <count>` triée par count desc
- Section repliable `C2S (Send) — <count>` triée par count desc
- Chaque type : nom (label si dispo, sinon `obf` en monospace), badge count, dot couleur (vert in / rouge out)
- Click sur un type → bascule sur Inspector tab pré-filtré
- Right-click → context menu : Rename type, Bookmark, Add note, Hide from sidebar, Copy obf name
- Footer : status (`🟢 Armed (N frames)` / `⚪ Disarmed`) + boutons `⚙ Configure`, `▶ Start`/`⏸ Stop`, `🗑 Clear`

**Onglet Stream** (default)
- Liste live, colonnes : `[time | dir | type | preview]`
- Direction : flèche colorée `←` (in/vert) ou `→` (out/rouge)
- Type : label si dispo (sinon obf monospace)
- Preview : `{ field1: value1, field2: value2, … }` (3-4 fields max, suffixe `…` si tronqué)
- Auto-scroll sticky (s'arrête si user scroll up, badge "↓ N nouvelles")
- Toolbar : filter input, pause, clear, export NDJSON, frame count `N / 5000`
- Click row → ouvre side-panel détail (component `network-detail`, vue A)

**Onglet Summary**
- Table dense, colonnes : `Type | Count | In | Out | Last seen | Fields observés`
- Click row → bascule Inspector pré-filtré sur ce type
- Click header → tri

**Onglet Inspector** (le killer feature)
- Dropdown de sélection `Type: [MapMovement ▽]` (ou pré-filtré depuis click sidebar/Summary)
- Table : 50 dernières instances de ce type (configurable par limit param)
- Colonnes auto-générées depuis l'union des fields observés sur ce type
- Pour les fields nested : colonne avec preview court, click pour expand modal
- **Highlights de variation** : cellule `bg: rgba(99,102,241,0.1)` quand la valeur change vs la row précédente du même direction
- Click sur cell → modal expand avec vue A (pretty-print indenté)
- Click sur header → tri
- Right-click cell → "Rename this field..." (passe à `labels.ts`)

**Vue détail (variante A — pretty-print indenté)**
Composant `network-detail` réutilisable :
- Header : nom type + direction pill + obf class + timestamp
- Body : un field par ligne, format `name : type    value` aligné via flex
- Nested : indent 24px + border-left 1px gauche colorée
- Arrays : `[N items]` puis chaque élément `[i]` indenté
- Bouton `Expand all / Collapse all` (utile pour gros messages)
- Toolbar bas : `Rename type`, `Bookmark`, `Copy JSON`, `Copy obf path`
- S'ouvre :
  - Comme **side-panel slide-in** (400px droite) depuis Stream click
  - Comme **modal** depuis Inspector cell click

### 8. Nav-icon ⇄ "Network"

Ajout dans `nav-icons.ts` après "Hooks", avant "Bookmarks". Route hash : `#/network`. Icône : `⇄` (couleur indigo standard quand inactif, indigo glow quand actif).

---

## Build-version migration (vis-à-vis SerializerConfig)

Au load d'un profil avec un build différent (pris en charge par le système migrations existant, qui migre déjà les labels) :

- Pour chaque `SerializerEntry`, vérifier que la classe + méthode existent encore avec la même signature.
- Si signature changée : entry marquée `stale`, pas de hook installé, badge `❌` dans la UI Configure.
- Si la classe a été renommée (par migration de labels.ts) : pas de souci, on cherche par nom obfusqué qui est conservé dans l'entry — l'affichage UI utilise le nouveau label automatiquement.
- L'user décide : re-pick la nouvelle signature ou supprimer l'entry.

Pas de migration auto des entries (trop risqué pour un hook de Send/Receive).

---

## Error handling

| Cas | Comportement |
|---|---|
| Auto-detect ne trouve aucun transport au 1er attach | Status "Disarmed (no transport)" + toast suggérant Configure |
| Hook installation échoue à arm | Skip cette entry, continue avec les autres, log dans Output, marker `❌` dans la liste config |
| Walk d'un objet plante (handle null, recursion bomb) | Catch global dans le wrapper agent, `send({type: "network-frame-error", entryId, error})` → row rouge dans Stream avec message |
| Anti-flood (>50 throws/sec sur une entry) | Auto-revert de cette entry uniquement, émet `network-auto-revert`, toast UI |
| Build update : signature changée | Entry marquée `stale`, pas hookée, badge `❌` dans Configure |
| Frame trop volumineuse (depth > 2) | Tronquée côté agent + flag `truncated: true` rendu dans UI ("…") |
| Agent disconnect / process crash | Status "Disarmed (disconnected)", frames in-memory conservées (read-only), boutons grisés |
| Concurrent Start/Stop click | Backend lock via `armInFlight: Promise<...>` (cohérent avec attach) |
| `MAX_FRAME_SIZE` JSON dépassé (50 KB après stringify) | Tronqué, `truncated: true` |

---

## Testing

**Pure modules** (vitest, comme partout dans `app/`) :
- `frame-store.test.ts` : push/list/byType/summary/clear, ring-buffer wrap-around, filter logic, sinceId pagination
- `type-aggregator.test.ts` : group-by-type, count split direction, lastSeen, observedFields union
- `serializer-config.test.ts` : load/save round-trip, schema migration v0→v1, entry validation logic
- `serializer-detector.test.ts` : mock RPC `findClassExact`, vérifier la détection des patterns connus (Google.Protobuf présent / absent, MessagePack présent / absent, Mirror présent / absent, fallback "rien trouvé")

**Routes** (TDD via supertest, pattern existant) :
- `routes-network.test.ts` : tous les endpoints `GET/POST/PUT/DELETE`, error cases (no profile, disarmed, type not found, malformed body)

**Pas de tests agent-side** (cohérent avec `hooks.ts` agent — trop coûteux à mocker `frida-il2cpp-bridge` ; smoke test manuel via attach Dofus).

**Smoke test manuel** documenté dans `app/SMOKE-TEST.md` (étendre l'existant) :
1. Attach → l'auto-detect remplit la SerializerConfig (sur Unity vanilla) ou la laisse vide (sur Dofus)
2. Sur Dofus : Configure → Add manual → pick une classe Network connue (ex `gbe-router.Dispatch`)
3. Start → frames arrivent dans le Stream, direction correcte
4. Click une frame → side-panel détail avec hiérarchie nested visible
5. Bascule Inspector → table par type avec 50 dernières instances
6. Vérifier highlights des cells qui changent
7. Right-click un type dans la sidebar → Rename → vérifier que le rename apparaît aussi dans Process Explorer (intégration `labels.ts`)
8. Stop → frames conservées, boutons OK
9. Detach → état nettoyé, page Network montre "Not attached"
10. Re-attach même profil → SerializerConfig persistée (même entries), status "Disarmed (config: N entries)"

---

## API additions for the agent

`src/rpc-agent/network.ts` exporte (via `exports`) :

- `armNetworkCapture(config: SerializerConfig): {installed: number; failed: SerializerEntry[]}`
- `disarmNetworkCapture(): void`
- `validateSerializerEntry(entry: SerializerEntry): {valid: boolean; reason?: string}`
- `listInstalledNetworkHooks(): SerializerEntry[]`

Évents `send()` :
- `{type: "network-frame", direction, timestamp, typeKey, fields, truncated?}`
- `{type: "network-frame-error", entryId, error}`
- `{type: "network-auto-revert", entryId, reason, detail}`

---

## Roadmap après v1.2

| Sprint | Quoi | Effort |
|---|---|---|
| **v1.2** (cette spec) | Plugin Network | ~1.5 semaine |
| **v1.2.1** | UDP support (avec config explicite de framing) | ~3-4 jours |
| **v1.2.2** | External schema loader (.proto, .desc) pour cas où serializer pas hookable | ~3-4 jours |
| **v1.3** | Plugin Deobfusc engine (auto-suggest labels) | ~1 semaine |
| **v1.4** | Plugin Scripts (DSL ou TS pour automation) | ~1-2 semaines |

---

## Appendix : settings (futurs, non exposés en UI v1.2)

```ts
// Constants in core/network/types.ts (no setting UI yet — YAGNI)
export const MAX_FRAME_DEPTH = 2;
export const MAX_FIELD_PREVIEW_CHARS = 80;
export const MAX_FRAME_BYTES = 50_000;
export const RING_BUFFER_SIZE = 5000;
export const FRAME_BROADCAST_THROTTLE_MS = 20;   // 50 broadcasts/sec max
export const ANTI_FLOOD_THROWS_PER_SEC = 50;
```

---

## Out of scope (explicitly)

- **UDP** — pas de framing implicite, demande UX dédiée → v1.2.1
- **HTTP / REST / UnityWebRequest** — Fiddler/Charles font mieux
- **Décodeurs externes (.proto, .desc, .fbs)** — décision Q4=B, on reste sur introspection objet IL2CPP
- **Capture raw byte[] au niveau socket** (`Socket.Send`, `ClientWebSocket.SendAsync`, etc.) — sans schéma c'est juste du hex, peu de plus-value vs hooking au niveau sérialiseur. Renvoyé à v1.2.x si un cas concret le justifie
- **Replay / inject / fuzz / mutate** — c'est un sniffer, pas un éditeur de paquets
- **Décrypte TLS in-process** — l'introspection objet C# est en clair par construction
- **Diff side-by-side de 2 frames** — Inspector visualise déjà les variations field-by-field
- **Auto-arm au prochain attach** — sécurité (cohérent avec plugin Hooks)
- **Persistance des frames cross-session** — volatil par design ; export NDJSON pour analyse externe
- **Sparkline / graphes temporels** — punté ; export NDJSON suffit
- **Stream multi-process / multi-jeu** — un toolkit = un process
- **Annotations ligne par ligne dans le Stream** — annotations sont per-type, pas per-frame
