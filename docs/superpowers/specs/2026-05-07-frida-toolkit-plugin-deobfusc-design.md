# Frida IL2CPP Toolkit — Plugin Deobfusc (v1.3) — Design Spec

> Étend le moteur de migration existant (classes-only) aux **fields** et **methods** pour que les renames survivent aux updates IL2CPP. Pas de nouvelle UI majeure — le panneau Migrations s'enrichit. Pas de "plugin" séparé : extension du core.

**Date** : 2026-05-07
**Branche cible** : `toolkit-core-v1` (continuité directe après v1.2 Network)
**Auteur** : brainstormé avec l'utilisateur (réponses Q1-Q4 résumées plus bas)
**Dépendances** : Toolkit Core v1 (fingerprints + migrations engine déjà en place pour les classes)

---

## TL;DR

Aujourd'hui, quand le jeu se met à jour :
- Les **classes** labellisées migrent automatiquement (token IL2CPP ou similarité Jaccard 0.95).
- Les **fields** et **methods** labellisés sont **silencieusement perdus** : leur clé `${classeObf}.${nameObf}` pointe vers du vide.

v1.3 corrige ça en deux passes :

1. **Passe 1 (inchangée)** : match les classes comme aujourd'hui.
2. **Passe 2 (nouveau)** : pour chaque classe matchée, match ses fields et ses methods individuellement avec une stratégie tiered — STRICT pour les fields (peu distinctifs, coût d'erreur élevé), LENIENT pour les methods (signatures riches, token souvent stable).

Le panneau Migrations existant absorbe les nouveaux records via une UI hybride : les AUTO se rollupent par classe (`+12 fields auto`), les REVIEW s'étalent un par un en haut de la liste.

**Out of scope v1.3** : suggestions automatiques de renames (heuristiques string-literals, refs cross-class) — c'est v1.4. Aucune nouvelle page Frontend, aucun nouveau plugin Backend.

---

## Décisions issues du brainstorm

| # | Question | Réponse |
|---|----------|---------|
| Q1 | Scope de v1.3 | **A — Strict** : étendre la migration existante aux fields/methods, pas d'heuristique de suggestion |
| Q2 | UX du panneau | **C — Hybride** : AUTO rollupés par classe, REVIEW étalés par item |
| Q3 | Tolérance d'erreur | **C — Tiered** : STRICT fields, LENIENT classes/methods |
| Q4 | Architecture | **A — Extension du core** : pas de plugin séparé, on enrichit `migrations.ts` |

---

## Architecture

Trois fichiers core touchés, deux côté agent, un côté frontend.

| Fichier | Rôle | Changement |
|---|---|---|
| `src/rpc-agent/fingerprints.ts` | Agent — capture fingerprints depuis VM IL2CPP | Remplacer `methodSignatures: string[]` et `fieldTypes: string[]` par `methods: MethodFingerprint[]` et `fields: FieldFingerprint[]` structurés ; capturer aussi `method.token` |
| `app/backend/core/types.ts` | Types partagés | Ajouter `FieldFingerprint`, `MethodFingerprint` ; faire de `MigrationResult` une union de records par `LabelKey` polymorphe |
| `app/backend/core/migrations.ts` | Engine de matching | Pipeline 2-passes : (1) classes existant tel quel, (2) fields+methods par classe matchée |
| `app/backend/routes/migrations.ts` | Routes accept/reject | Payload `{key: LabelKey, ...}` au lieu de `{oldObf, newObf}` brut ; backward-compat alias |
| `app/frontend/components/migrations.ts` | Panneau UI | Layout 3 zones : REVIEWs en haut (par item), AUTO rollupés au milieu (par classe avec breakdown au click), LOST collapsed en bas |
| `app/frontend/core/api.ts` | Client RPC | Adapter signatures accept/reject au payload polymorphe |

**Pas de nouveau plugin, pas de nouveau menu, pas de nouvelle page.** Le panneau Migrations existant absorbe la nouvelle granularité.

**Backward-compat des labels.** Les labels stockés avant v1.3 (clés `${classeObf}.${fieldObf}`) sont migrés tels quels au prochain attach. La migration engine prend toujours l'état courant comme source — pas besoin d'embarquer un fingerprint dans chaque `LabelEntry`. Le store `labels.ts` ne change pas du tout.

---

## Data model

### Côté agent — `src/rpc-agent/fingerprints.ts`

```typescript
interface ClassFingerprint {
    obfName: string;
    token: string | null;             // hex IL2CPP token de la classe
    parents: string[];                // parents + interfaces, triés
    fields: FieldFingerprint[];       // NEW — était fieldTypes: string[]
    methods: MethodFingerprint[];     // NEW — était methodSignatures: string[]
    methodCount: number;              // gardé (utilisé par jaccard classe)
}

interface FieldFingerprint {
    obfName: string;
    typeName: string;                 // ex: "System.Int32"
    declIndex: number;                // position dans klass.fields (0-based)
    isStatic: boolean;
    isPublic: boolean;
}

interface MethodFingerprint {
    obfName: string;
    token: string | null;             // hex IL2CPP token de la méthode
    paramTypes: string[];             // résolus, ordre déclaratif
    returnType: string;
    paramCount: number;               // redondant mais utile pour scoring rapide
    declIndex: number;
    isStatic: boolean;
}
```

**Pourquoi ces champs précis :**
- `declIndex` : tiebreaker pour fields homogènes (3× `int`, on désambiguïse par position-dans-le-groupe-de-type).
- `isStatic`/`isPublic` : signaux gratuits — deux fields de même type dont un est `static` et l'autre `instance` ne se confondent pas.
- `method.token` : signal d'identité fort entre builds, généralement plus stable que les noms obfusqués.

### Côté core — `app/backend/core/types.ts`

```typescript
export interface MigrationResult {
    auto:   MigrationAutoRecord[];
    review: MigrationReviewRecord[];
    lost:   MigrationLostRecord[];
}

export interface MigrationAutoRecord {
    key: LabelKey;                    // class | method | field
    oldObf: string;                   // pour fields/methods : "className.memberName"
    newObf: string;
    label: string;
    reason: string;                   // "token match", "exact signature", "type+ordinal", etc.
    parentClassMigration?: string;    // référence au record class parent (pour grouping UI)
}

export interface MigrationReviewRecord {
    key: LabelKey;
    oldObf: string;
    candidates: Array<{ newObf: string; score: number; reason: string }>;
    label: string;
    parentClassMigration?: string;
}

export interface MigrationLostRecord {
    key: LabelKey;
    oldObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}
```

**Coût mémoire.** Pour un build Dofus typique (~10k classes × ~5 fields × ~5 methods en moyenne) : ~50k entités fingerprintées, stockées dans le profile en JSON, ~2-4 MB. Acceptable.

---

## Migration engine — algorithme

Pipeline en deux passes dans `app/backend/core/migrations.ts`.

### Passe 1 : classes (inchangée)

Algorithme actuel gardé tel quel. La seule adaptation : le calcul Jaccard des fields/methods consomme désormais `fields.map(f => f.typeName)` et `methods.map(m => m.obfName + "(" + m.paramTypes.join(",") + ")→" + m.returnType)` au lieu des champs `fieldTypes` et `methodSignatures` retirés.

Comportement inchangé :
- Token match → AUTO
- Score ≥ 0.95 ET unique (gap > 0.10 avec le second) → AUTO
- Score ≥ 0.60 → REVIEW (top 5 candidats)
- Sinon → LOST

### Passe 2 : fields + methods par classe matchée

Pour chaque classe en `auto[]` après passe 1, on matche **uniquement** les labels portés par cette classe. Une classe en `review[]` voit sa passe 2 différée jusqu'à acceptation utilisateur (cf. cascade plus bas).

#### Methods — LENIENT

Algorithme cascadé, on s'arrête au premier qui réussit :

1. **Token match** : `oldMethod.token === newMethod.token` (et token non-null) → AUTO, reason `token match`.
2. **Signature exacte name-preserved** : `(name, paramTypes, returnType)` égal et unique côté nouveau → AUTO, reason `exact signature, name preserved`.
3. **Signature exacte sans name** : `(paramTypes, returnType)` égal et unique côté nouveau → AUTO, reason `signature match, renamed method`.
4. **Score structurel** :
   `score = 0.4 × paramCount_proximity + 0.4 × paramTypes_jaccard + 0.2 × returnType_match`
   - ≥ 0.95 ET unique (gap > 0.10) → AUTO, reason `unique structural match (score=X.XX)`
   - ≥ 0.60 → REVIEW (top 5 candidats)
   - sinon → LOST, reason `no candidate above 0.60 similarity`

Où `paramCount_proximity = max(0, 1 - |a - b| / max(a, b, 1))` et `returnType_match` = 1 si égal, 0 sinon.

#### Fields — STRICT

Algorithme à courtes règles, plus restrictif :

1. **Type unique des deux côtés** : le `typeName` de l'old field n'apparaît qu'une fois côté old ET qu'une fois côté new → AUTO, reason `unique type match`.
2. **Type N×N avec position alignée** : type T apparaît exactement N fois côté old et N fois côté new, ET le N-ième field de type T côté old correspond au N-ième côté new (par ordre de `declIndex` croissant) → AUTO, reason `type+ordinal match (position N of type T)`.
3. **Type N×M avec N≠M** (ajout/retrait) → REVIEW. Candidats = tous les fields nouveaux du même `typeName`, triés par `|declIndex - oldDeclIndex|` ascendant, top 5. Reason `type ${T} count changed (old=N, new=M)`.
4. **Type disparu** côté nouveau → LOST, reason `type ${T} disappeared`.

Note : la règle 2 est volontairement étroite. Si **un seul** field est ajouté/retiré dans la classe, tous les `declIndex` au-delà glissent et on bascule en REVIEW pour cette tranche-là — exactement le comportement souhaité (STRICT, on préfère le clic utilisateur au mauvais rename silencieux).

#### Cascade : classe → ses members

Quand une classe est en `auto[]` après passe 1 → passe 2 immédiate, records insérés dans `result.auto` / `result.review` / `result.lost` selon l'algorithme ci-dessus. Tous portent `parentClassMigration: oldClass.obfName` pour le grouping UI.

Quand une classe est en `review[]` après passe 1 → ses fields/methods labels sont **suspendus**. Pas de records émis. Quand l'utilisateur accepte la classe (`POST /api/migrations/accept`), le serveur déclenche la passe 2 sur cette classe + insère les nouveaux records en mémoire + broadcast WS `migration-updated`.

Quand une classe est en `lost[]` → tous ses fields/methods labels passent directement en `lost[]` avec reason `parent class lost: ${oldClass.obfName}`.

---

## Routes & API

### `GET /api/migrations`

Retourne le `MigrationResult` complet (auto + review + lost). Schéma plus riche qu'avant mais structurellement compatible : un client v1.2 qui ne lit que `oldObf`/`newObf`/`label` continue de marcher.

### `POST /api/migrations/accept`

**Avant (v1.2)** :
```json
{ "oldObf": "fzc", "newObf": "abc" }
```

**Après (v1.3)** :
```json
{ "key": { "kind": "class", "className": "fzc" }, "newObf": "abc" }
```

Backward-compat alias : si le payload n'a pas `key`, le serveur le construit comme `{ kind: "class", className: oldObf }` (le format v1.2 ne supportait que les classes).

Effets de bord (cas classe acceptée) :
1. `labels.set(newKey, label)` + `scheduleFlush()`
2. Déplace le record du `review[]` vers `auto[]` avec reason `user accepted`
3. **Déclenche la passe 2** sur cette classe — insère les nouveaux records fields/methods dans `result`
4. Broadcast WS `migration-updated` avec le delta

Effets de bord (cas method/field accepté) :
1. `labels.set(newKey, label)` + `scheduleFlush()`
2. Déplace le record du `review[]` vers `auto[]` avec reason `user accepted`
3. Broadcast WS `migration-updated`

### `POST /api/migrations/reject`

Symétrique :
```json
{ "key": { "kind": "field", "className": "fzc", "fieldName": "emjv" } }
```

Backward-compat alias `{ oldObf }` accepté pour les classes.

Effets de bord :
1. Déplace le record du `review[]` vers `lost[]` avec reason `user rejected`
2. **Si rejet d'une classe** : ses fields/methods (qui étaient suspendus) basculent directement en `lost[]` avec reason `parent class rejected by user`
3. Broadcast WS `migration-updated`

---

## UI : panneau Migrations en mode hybride

Le composant Frontend `app/frontend/components/migrations.ts` est restructuré en **trois zones empilées verticalement**.

### Zone 1 (haut) : REVIEWs étalés — un row par item ambigu

```
[!] REVIEW    fzc.emjv → ?            [string]   3 candidats
              Old:  fzc.emjv  →  "playerName"
              New:  fzc.aaa  (score 0.90)  ← preview
                    fzc.bbb  (score 0.85)
                    fzc.ccc  (score 0.71)
              [Accept aaa] [Accept bbb] [Accept ccc] [Reject all]
```

- Chaque ligne a son `kind` (icône classe/méthode/field via `core/icons.ts`), son score, sa picker de candidats inline.
- Les fields/methods d'une même classe REVIEW sont groupés visuellement sous la ligne classe parente (indentation gauche), mais restent actionnables individuellement.
- Si une classe est en REVIEW, ses fields/methods n'apparaissent **pas encore** (suspendus jusqu'à acceptation). Indicateur : `[?]  fzc → ? (then 4 fields, 7 methods will resolve)`.

### Zone 2 (milieu) : AUTOs rollupés par classe

```
[✓] fzc → fzc                                    Token match
    +18 methods auto · +7 fields auto             [Show breakdown]
[✓] gup → xyz                                    score 0.97
    +5 methods auto · +12 fields auto             [Show breakdown]
```

- Click "Show breakdown" → expand inline qui révèle chaque method/field migré avec son `reason` (token, exact signature, type+ordinal, etc.). Permet vérification sans cliquer 50 boutons.
- Pas d'action utilisateur requise par défaut sur les AUTOs (déjà appliqués au store).
- Cas particulier : si une classe a `oldObf === newObf` (token match exact, le nom obfusqué n'a pas changé entre les builds), elle apparaît quand même comme une ligne AUTO si **un de ses members a migré**. Sinon elle est invisible (rien à signaler).

### Zone 3 (bas, collapsed par défaut) : LOST

```
[×] LOST (4)  [Show details]
    fzc.foo (field, type System.Object disappeared)
    deadClass (no candidate above 0.60)
    deadClass.bar (parent class lost)
    deadClass.baz (parent class lost)
```

Click "Show details" → expand. Aucune action sauf consultation/export.

### Bulk actions (toolbar en haut)

- **Accept top candidate for all REVIEWs** — one-click, accepte le candidat #1 de chaque record `review[]`. Pour utilisateurs qui font confiance au top suggestion. Confirmation modale (`This will accept N migrations. Continue?`) avant exécution. Désactivé si zone 1 vide.
- **Show only REVIEWs** — toggle qui collapse zone 2 et zone 3.
- **Export migration report (NDJSON)** — utile pour audit, copy-paste cross-machine, ou debug.

### WebSocket events

Évent existant `migration-updated` (déjà broadcast par les routes) suffit. Le composant re-render complètement à chaque `migration-updated`. Pas de nouveau channel WS.

---

## Tests

Stratégie TDD vitest, comme v1.2.

### Backend pur — `app/test/backend/core/migrations.test.ts` enrichi

Tests **classes** existants gardés tels quels. Ajouts :

**Field matching :**
- ✓ Type unique des deux côtés → AUTO avec reason `unique type match`
- ✓ Type N×N avec mêmes `declIndex` → AUTO avec reason `type+ordinal match`
- ✓ Type N×N avec `declIndex` shifté (un field inséré devant) → REVIEW (pas AUTO, c'est ça la STRICT-ness)
- ✓ Type N×M (N≠M) → REVIEW avec candidats triés par proximité de `declIndex`
- ✓ Type disparu côté nouveau → LOST avec reason `type disappeared`
- ✓ Cascade : classe LOST → tous ses fields labels en LOST

**Method matching :**
- ✓ `token` égal → AUTO avec reason `token match`
- ✓ Signature exacte (name+params+return) unique → AUTO `exact signature, name preserved`
- ✓ Signature sans name unique → AUTO `signature match, renamed method`
- ✓ Score ≥ 0.95 unique → AUTO `unique structural match`
- ✓ Score ≥ 0.60 → REVIEW (top 5 candidats)
- ✓ Score < 0.60 → LOST

**Cascade de l'accept :**
- ✓ Classe en REVIEW acceptée → re-run passe 2 sur ses fields/methods → records insérés
- ✓ Classe en REVIEW rejetée → ses fields/methods labels passent en LOST avec reason `parent class rejected by user`

### Backend routes — `app/test/backend/routes/migrations.test.ts` enrichi

- ✓ `accept` accepte un payload `{key: LabelKey, ...}` polymorphe (class/method/field)
- ✓ `reject` idem
- ✓ Backward-compat : payloads anciens `{oldObf, newObf}` continuent de marcher (alias interne)
- ✓ Accept classe déclenche re-passe 2 et broadcast `migration-updated` avec les nouveaux records
- ✓ Reject classe cascade ses fields/methods vers LOST

### Frontend — `app/test/frontend/components/migrations.test.ts`

- ✓ Render zone REVIEWs avec rows par item
- ✓ Render zone AUTOs rollupés + breakdown au click
- ✓ Render zone LOST collapsed
- ✓ Accept/Reject envoient le bon payload polymorphe
- ✓ WS `migration-updated` re-render le composant
- ✓ Bulk action "Accept top candidate for all REVIEWs" envoie N requêtes accept correctes après confirmation modale

### Agent (smoke) — manuel

L'agent tourne dans la VM Frida, pas testable unitairement. Smoke-test sur Dofus :

1. Build courant attaché → labels créés sur quelques classes/fields/methods Network (`fzc.Encode`, `emjv` field).
2. Forcer un nouveau `buildId` en attachant un build différent (ou en éditant manuellement le profile dir pour simuler).
3. Vérifier panneau Migrations : AUTO/REVIEW/LOST cohérents, accept/reject font les bons effets, broadcast WS observable.

**Cible** : 167 tests verts (baseline v1.2) + ~25 nouveaux = ~192 tests verts.

---

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| **Faux AUTO sur fields** (rename silencieux du mauvais field) | Stratégie STRICT (règles 1-2 seulement, pas de score-based AUTO pour fields). Si type+position ne matchent pas exactement, on bascule en REVIEW. |
| **Token IL2CPP pas toujours stable** entre builds | Token est juste le premier essai de la cascade method. Les passes suivantes (signature exacte → score) fournissent des fallbacks. Les tests vérifient chaque passe en isolation. |
| **Coût mémoire** des fingerprints structurés | ~2-4 MB par profile, stocké en JSON sur disque, lu en mémoire seulement à l'attach. Acceptable, mesuré sur Dofus build courant. |
| **Cascade infinie d'accept** déclenchant re-renders | Re-passe 2 est purement locale à la classe acceptée (pas récursive). Broadcast WS unique par accept. |
| **Backward-compat des labels existants** | Les labels v1.2 sont `${className}.${fieldName}` — la passe 2 lit `labels.fields` et matche par cette clé, pas besoin de migration de schéma de stockage. |
| **Backward-compat des payloads accept/reject** | Alias interne sur les routes : si pas de `key`, on assume `{kind: "class", className: oldObf}`. Tests dédiés. |

---

## Out of scope v1.3

- **Suggestions automatiques de renames** (heuristiques sur string literals embarqués, refs cross-class, patterns de nommage) → v1.4 si jugé utile.
- **AI-assisted rename suggestions** (LLM lit le code décompilé) → v1.5 ou jamais.
- **Editor inline de fingerprints** (override manuel des matchings depuis l'UI) → tant que l'algorithme STRICT/LENIENT donne des résultats utilisables, pas nécessaire.
- **Diff visuel old→new fingerprint** (afficher quels champs ont changé) → joli-à-avoir, mais l'algorithme suffit pour décider auto/review/lost.
- **Migration entre profiles** (importer les labels d'un autre profile + les fingerprints associés) → le store labels supporte déjà `bulkImport`, mais sans fingerprints associés c'est un gain marginal.

---

## Critère d'acceptation v1.3

- ✅ ~192 tests verts (baseline v1.2 + ~25 nouveaux)
- ✅ Build vite + tsc clean
- ✅ Smoke-test Dofus : sur un changement de buildId simulé, les labels fields/methods de `fzc.Encode` (Network plugin) survivent et apparaissent dans le panneau Migrations comme AUTO ou REVIEW selon le scénario
- ✅ Pas de régression sur les migrations classes existantes (les tests v1.2 passent toujours)
- ✅ UI : 3 zones lisibles, breakdown des AUTOs accessible, bulk-accept fonctionnel
