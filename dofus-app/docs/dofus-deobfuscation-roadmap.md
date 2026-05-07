# Dofus 3.0 — Roadmap de déobfuscation

État : ~75 classes obfusquées identifiées avec un score de triangulation ≥ 3 (voir [`deobfuscation-map.md`](./deobfuscation-map.md)). Le présent doc liste ce qui est **techniquement faisable ensuite**, classé par leverage, et trace ce qu'on a décidé d'attaquer.

## Légende
- 🟢 **En cours** ou planifié dans la session courante
- 🟡 **À faire ensuite** (queue prioritaire)
- ⚪ **Optionnel / nice-to-have**

---

## Très haut leverage (faisable immédiatement)

### 🟢 1. Cross-réf Protocol → handler obfusqué
Chacun des **4892 messages `Ankama.Dofus.Protocol.Game`** est traité par un handler obfusqué. La signature `void Handler(SomeProtoMessage)` est unique → en faisant `findByMethod({paramType: "Ankama.Dofus.Protocol.Game.X"})` on trouve la classe obfusquée qui le gère, batch sur les 4892 messages.

**Gain attendu** : centaines de classes obfusquées nommées par leur message Protobuf (ex : `xxx → handles MovementMessage`). Si une classe gère plusieurs messages d'un même domaine, son rôle devient évident.

**Effort** : ~30 min de scripting + temps d'exécution Frida.

### 🟢 2. Dump le routing table de `gbe` (le dispatcher Protobuf)
`gbe` a 4 méthodes prenant `(Type, IMessage, fzz, gaa)` (`kvj/jsl/iad/otz`) — c'est le `Register/Send` de la table de routing. Hook ces méthodes ou lis le dictionnaire interne en mémoire → on obtient **le mapping exact `MessageType → handler instance`**.

**Gain attendu** : preuve hard du mapping #1, plus la liste des handlers actifs runtime.

**Effort** : ~30 min (need to either dump fields or hook).

### 🟢 4. Dump 50+ classes obfusquées en plus
On a 75 candidats avec score ≥ 3, dont seulement 16 dumpés deeply. Étendre à 50-60 avec `dumpClassAsString` permet d'enrichir massivement la table de type-refs → meilleure triangulation par #4 (type system leak).

**Gain attendu** : passage de 75 → ~150 classes identifiées avec un label correct.

**Effort** : 5 min de scripting + parse.

### 🟡 3. Field-type chain recursion
`egq` référence `enr/enq/eop` (autres classes obfusquées) → ce sont vraisemblablement des caches/configs HAAPI. En suivant les types de fields récursivement on construit un **graphe par domaine**.

**Gain attendu** : grappes complètes de classes obfusquées par domaine fonctionnel (ex : tout l'écosystème HAAPI runtime, tout le pipeline audio FMOD…).

**Effort** : ~1h scripting (BFS/DFS sur les type refs).

---

## Haut leverage, plus de travail

### 🟡 5. Lire les CustomAttributes IL2CPP (bypass du bridge)
`frida-il2cpp-bridge` n'expose pas les CustomAttributes natifs. Bypass via `Memory.read*` direct sur `il2cpp_class_get_custom_attribute_class` / `mono_custom_attrs_from_class`. Une fois implémenté :
- **Distingue les vraies classes des fake leurres** injectés par OPS (filtrage du bruit, énorme gain de signal)
- Lit le texte du `[NotObfuscatedCause("reason")]` = **doc interne Ankama** sur pourquoi telle classe n'est pas obfusquée
- Détecte précisément `[DoNotRename]` plutôt que de l'inférer

**Gain attendu** : qualité de la map passe de "heuristique" à "ground truth".

**Effort** : ~2-3h (Frida natives + tests).

### 🟡 6. Mining des bindings XLua
XLua expose les classes C# au scripting Lua. Le binding **doit utiliser les vrais noms** (Lua = string-based reflection). Dumper `XLua.LuaEnv.translator` ou les wrap tables → **mapping `nom_obfusqué → nom_lua_exposé`** pour toutes les classes scriptables.

**Gain attendu** : mapping clean pour toutes les classes exposées Lua (probablement les enums Combat/Spell + APIs Game).

**Effort** : ~1h (need to understand XLua internals).

### 🟡 7. Hook + log live (preuve runtime)
Sur les classes déjà identifiées (`fzb`, `gbe`, `egq`, `emb`, `els`…), hooker quelques méthodes et logger les invocations en jouant le client : login → ouvrir boutique → lancer combat. Confirme l'identification + révèle l'**ordre du pipeline**.

**Gain attendu** : compréhension de la séquence d'appels, plus que des labels statiques.

**Effort** : ~1h par scénario (login, combat, etc.).

### ⚪ 8. Sentry breadcrumb harvesting
Sentry collecte des breadcrumbs avec noms de méthodes. Si Ankama a oublié de les obfusquer (souvent le cas en release), on dump `Sentry.SentrySdk.CurrentHub.Scope.Breadcrumbs` après quelques minutes de gameplay → **mapping live des paths chauds**.

**Effort** : ~30 min, dépend de comment Sentry est configuré.

---

## Approches complémentaires (statique offline)

### ⚪ 9. Il2CppDumper / Il2CppInspector
Sortir de Frida, faire un dump statique de `GameAssembly.dll` + `global-metadata.dat`. Génère des dummy DLLs ouvrables dans dnSpy/IDA.

**Avantages** : vue d'ensemble navigable, CustomAttributes lisibles directement (résout #5), peut résoudre des refs que Frida ne voit pas (faute d'instance live).
**Inconvénient** : nécessite les fichiers du jeu sur disque.

### ⚪ 10. Rename layer dans le toolkit
Une fois la map à 60-70% de couverture, hook côté Frida pour intercepter `Il2Cpp.Class.name` et retourner le nom déobfusqué quand connu. **Tous les outils existants du toolkit afficheraient les vrais noms** sans modification.

**Gain UX** : très haut, transforme tout ça en outil utilisable au quotidien.

---

## Trucs marginaux

### ⚪ 11. Stacktrace forced
Provoquer une exception sur une méthode hookée → la stacktrace IL2CPP donne `obf_class.obf_method`. Si on connaît déjà la classe (via héritage), on gagne le mapping de quelques méthodes.

### ⚪ 12. Generic argument leak
Pour `fpz\`1<T>` (UI base générique), chaque sous-classe instancie avec son `T` concret → on récupère le **pattern de design UI** d'Ankama (`UIData → UI` mappé).

---

## Plan d'attaque immédiat (cette session)

Ordre d'exécution choisi : **#4 → #1 → #2**, puis re-run du `build-deobfuscation-map.py`.

### Résultats de session

1. ✅ **Roadmap doc créé** (ce fichier)

2. ✅ **#4 — 80 classes obfusquées dumpées** (`dumpClassAsString` batch sur les top scoring)
   - Stockage : `%TEMP%\dumps\<obf>.txt` (1 fichier par classe)
   - Map regen : passage de 16 → 81 classes deeply inspected
   - Top 15 identifications maintenant tous labelisés (vs ~10 avant)
   - Score moyen monté : `eat` 21→85, `fdy` 5→81, `eah` 19→56, etc. (les nouvelles refs de types ont enrichi la triangulation)

3. ✅ **#1 — Cross-réf Protocol → handlers : MAPPING COMPLET ÉTABLI** (sauf noms .proto)
   - **Découverte** : `Ankama.Dofus.Protocol.Game` est **aussi obfusqué** (1443 message classes top-level renommées en `gud, gue, guf, ...`). Mais le wire format Protobuf est préservé.
   - **Tentatives runtime descriptor** : invoquer `get_Descriptor()` ou lire `FileDescriptor` static field → tous les results sont null. Les FileDescriptors sont **lazy-init seulement à la première utilisation runtime** et ne sont pas exposés via les APIs Frida classiques.
   - **Pivot stratégique** : plutôt que les noms .proto, scanner toutes les méthodes du Core dont un paramètre est une classe Protobuf → **mapping structurel `obf_message → handler_class`**.
   - **Résultats** :
     - 1443 messages indexés
     - **3203 handler hits** dans Core
     - **810 messages ont au moins 1 handler** (56% du protocole)
     - **256 dispatcher classes** identifiées
     - **703 messages ont exactement 1 handler** (1:1 propre)
     - **17 messages identifiés** par leak via clear-handlers (e.g. `khe → FightEntities event`, `khn → Inventory event`)
   - **Cluster effect** : depuis ces 17 messages, 30 dispatcher classes obfusquées labellisées (`ehk` = service Roleplay/EndTurn/FightEntities, `ks/cp/elz` = Inventory, `ezc/fav/ejt/eyp/fak/fbk` = BuffsFight, etc.)
   - **Output** : [`protocol-handlers.md`](./protocol-handlers.md), [`protocol-handlers.json`](./protocol-handlers.json), [`protocol-message-labels.json`](./protocol-message-labels.json)
   - **RPC ajouté** : `buildProtoHandlerMap` dans `explorer.ts` (et `harvestProtoSchema`, `dumpStaticByteArrays`, `dumpProtobufFileDescriptors` pour les tentatives — tous fonctionnent mais retournent données vides à cause du lazy init)
   - **Pistes pour récupérer les noms .proto** (à faire plus tard) :
     - Hook `MessageParser<T>.ParseFrom` au runtime quand un vrai paquet arrive
     - Trigger une vraie connexion réseau (login complet) pour forcer l'init des FileDescriptors, puis re-scan
     - Solution offline : Il2CppDumper sur les fichiers du jeu

4. ⚠️ **#2 — Dump table de routing `gbe` : structure identifiée, pas dumpée runtime**
   - Structure de `gbe` analysée : 4 nested classes (`gbe.gaz`, `gbe.gba`, `gbe.gbb`, `gbe.gbc`) sont vraisemblablement les 4 dictionnaires `Type → Handler` (un par type de handler).
   - 4 méthodes `void Send(Type, IMessage, fzz, gaa)` : `kvj`, `jsl`, `iad`, `otz`, `bidj`
   - 4 méthodes `void Register(Type, X)` : `bbja(Type,d)`, `bbjd(Type,h)`, `bide(b,fzz)`, etc.
   - Pour dumper la table, il faut **trouver l'instance singleton de `gbe`** au runtime (via SCANNER) puis lire les 4 fields des 4 dictionaries — chaque entrée donne `Type → handler_obj`. Le `Type.Name` étant l'obf message class, on cross-ref avec #1 pour résoudre le vrai nom.
   - À faire : utiliser `findInstancesOf("gbe")` du toolkit, puis hook ou read direct.

5. ✅ **Regen build-deobfuscation-map.py** :
   - 17 assemblies + 81 class dumps maintenant
   - Génère [`deobfuscation-map.md`](./deobfuscation-map.md) + `.json`
   - Confiance forte sur les ~15 top, raisonnable sur les ~50 suivants

## Session 2 — Runtime Protobuf sniffing (terminée)

Tentative de récupérer les noms `.proto` au runtime via 3 hooks (descriptor + ParseFrom + CodedInputStream).

### Résultats
- ❌ `FileDescriptor.FromGeneratedCode` : jamais appelé. Dofus a désactivé la couche descriptor.
- ❌ `MessageDescriptor..ctor` : jamais appelé.
- ❌ `MessageParser.ParseFrom` (base) : jamais appelé (les génériques `MessageParser<T>` sont utilisés directement).
- ✅ `CodedInputStream.ReadMessage` : **178 hits sur 24 messages distincts** capturés en quelques actions.
- 🔑 Découverte clé : **`gui` est l'envelope universelle** (89 hits, oneof wrapper).
- 🚨 Le PC du user a crashé pendant l'investigation — les 3 hooks intercept-tout sont coûteux pour le thread réseau du jeu sous gameplay actif. À ne pas réinstaller en production.

### Outputs session 2
- [`protocol-runtime-observations.md`](./protocol-runtime-observations.md)
- RPC ajoutés : `installProtoNameSniffer`, `installParseFromSniffer`, `installCodedInputSniffer`, `getCollectedProtoData`

## Session 3 — Pivot offline avec Cpp2IL + ilspycmd (terminée)

Stratégie : sortir du runtime, dumper les binaires offline pour analyse statique. Aucun risque pour le jeu.

### Pipeline
1. **Cpp2IL** (pré-release 21, 2026-02) sur `GameAssembly.dll` + `global-metadata.dat` (v39, Unity 6000.3.3f1) → dummy DLLs avec types complets
2. **ilspycmd** (dotnet tool 10.0.1.8346) → 5998 fichiers `.cs` pour `Core.dll`, 1607 pour `Protocol.Game.dll`
3. **Scripts Python** d'extraction des leaks préservés dans la décompilation

### Résultats
- ✅ **Méthodes async avec signature COMPLÈTE** : 318 méthodes avec params nommés + types (vs 0 avant) — exemple : `egq.CreateTokenWithPassword(account: string, password: string, game: long)`
- ✅ **514 méthodes async** avec nom original (vs 471 avant)
- ✅ **Schéma Protobuf complet** : 1323 messages × 5462 fields avec tag + type — il manque juste les noms .proto
- ✅ **Confirmation `gui`** : 2 fields = `object payload + guh enum case` (oneof wrapper officiel)
- ❌ **Noms .proto non récupérables** : OPS Obfuscator a strippé les noms du metadata IL2CPP. Seul matching structurel contre docs communautaires possible.
- ❌ **CustomAttributes strippés** : pas de distinction vraies/fake classes.

### Outputs session 3
- [`dofus-deobfuscation-final.md`](./dofus-deobfuscation-final.md) — synthèse finale (à lire d'abord)
- [`decompiled-leaks.md`](./decompiled-leaks.md) — 318 signatures complètes
- [`proto-schema-decompiled.md`](./proto-schema-decompiled.md) — schéma .proto (1323×5462)
- `data/decompiled-class-info.json`, `data/proto-schema-decompiled.json`
- Scripts : `extract-decompiled-leaks.py`, `extract-proto-schema-from-decompiled.py`
- Builder principal `build-deobfuscation-map.py` mis à jour pour merger les 6+ vecteurs

## Session 4 — Recherche FileDescriptor + extraction métadata (terminée)

Tentative de la "piste #1 originale" (récupérer les noms `.proto` via les `static byte[]` FileDescriptor embarqués dans le binaire).

### Résultats
- ❌ **FileDescriptor byte[] confirmé absent** des 3 surfaces (DLL Cpp2IL, GameAssembly.dll natif, global-metadata.dat). Ankama a complètement strippé le système au build.
- ✅ **Pivot: 99 fichiers `.proto` identifiés** via les paths source `\PackageCache\com.ankama.dofus.protocol.game@68c300a36ca8\Runtime\<Name>.cs` dans le metadata IL2CPP. Convention `protoc-csharp` : `Inventory.cs ↔ inventory.proto`. Donne le **périmètre complet du protocole**.
- ✅ Lancement de **Cpp2IL avec `--use-processor "attributeanalyzer,attributeinjector"`** — découverte des processors qui injectent les attributs IL2CPP dans les DLLs (utilisé en session 5).

### Outputs session 4
- [`proto-descriptor-extraction.md`](./proto-descriptor-extraction.md)
- [`data/protocol/proto-source-files.json`](../data/protocol/proto-source-files.json) — 99 fichiers
- Scripts : `extract-proto-descriptors-from-dll.py` (négatif, confirme strip), `extract-proto-source-names.py`

## Session 5 — Indexation Cpp2IL avec attributs (Voie B, terminée)

Décompilation des DLLs Cpp2IL enrichies par session 4 → indexation complète Token + RVA + FieldOffset + GeneratedCode.

### Résultats
- ✅ **7600 types indexés** (5992 Core + 1608 Protocol.Game)
- ✅ **89 081 méthodes avec RVA native exacte** dans `GameAssembly.dll` (100 %)
- ✅ **5228 fields avec FieldOffset C++**
- ✅ **1442 classes Protobuf-generated identifiées** sans ambiguïté via `[GeneratedCode("protoc"]`
- ✅ **479 méthodes mappées `obf_name → original_name → RVA`** via détection automatique de `[AsyncStateMachine(typeof(_003C<Name>_003Ed__N))]`
- ✅ **256 méthodes** des classes du deob map résolues à RVA (e.g. `egq.ywp = ConsumeKardByCode @ 0x16FD310`)
- ✅ **Rename table compacte** (149 KB) : `frida-rename-table.json` consommable par un futur hook layer Frida

**Impact opérationnel** : tous les hooks Frida deviennent **atomiques** (par RVA précise), résolvant le problème de crash session 2.

### Outputs session 5
- [`cpp2il-attribute-index.md`](./cpp2il-attribute-index.md)
- [`data/indexed/core.classes.json`](../data/indexed/core.classes.json) — 34 MB
- [`data/indexed/protocol-game.classes.json`](../data/indexed/protocol-game.classes.json) — 14 MB
- [`data/indexed/deobmap-enriched.json`](../data/indexed/deobmap-enriched.json) — 855 KB
- [`data/indexed/frida-rename-table.json`](../data/indexed/frida-rename-table.json) — **150 KB, table de rename pour Frida**
- Scripts : `index-cpp2il-attrs.py`, `enrich-deobmap-with-rva.py`, `build-frida-rename-table.py`

## Session 6 — Match structurel vs ModulX/dofus-unity-proto (Voie A, terminée)

Récupération des `.proto` Dofus Unity publics + matching par signature.

### Résultats
- ✅ **3 repos publics identifiés** : ModulX (80 .proto + 1285 mappings), LuaxY, RuinedYourLife
- ✅ **27 messages `.proto` nommés haute confiance** (signature 1:1 unique non-triviale)
- ✅ **744 messages avec candidate set** (1-10 noms possibles chacun, désambig humaine ou propagation)
- ✅ **1284 noms canoniques de messages Ankama** disponibles comme catalogue de référence
- ⚠️ Limité par **divergence de versions** : sources publiques datent d'Aug 2024, notre snapshot est plus récent (25 nouveaux modules `.proto` chez nous).

### Outputs session 6
- [`voie-a-proto-name-matching.md`](./voie-a-proto-name-matching.md)
- [`data/external/dofus-unity-proto/`](../data/external/dofus-unity-proto/) — clone ModulX
- [`data/indexed/proto-name-mapping-v2.json`](../data/indexed/proto-name-mapping-v2.json)
- Scripts : `match-proto-against-modulx.py`, `match-proto-v2.py`, `integrate-proto-mapping.py`

## Session 7 — RPC modules runtime + DataCenter + Dofus 2 cross-ref (terminée 2026-04-29)

Stratégie : ajouter de nouvelles sources de signal (runtime probes, dump des données statiques, comparaison vs protocole legacy Dofus 2) plutôt que de continuer à raffiner la map structurelle.

### Modules Frida ajoutés (5)

Tous dans `src/rpc-agent/` ; agrégés via `rpc-methods.ts` ; build OK via `npm run build:rpc`.

| Module | Fonctions exposées | But |
|---|---|---|
| `sentry.ts` | `installSentryHooks`, `getSentryBreadcrumbs`, `clearSentryBreadcrumbs`, `getSentryStats` | Hook les 4 entry points statiques de `Sentry.SentrySdk` (AddBreadcrumb / CaptureMessage / CaptureException / CaptureEvent) pour intercepter les strings hardcodées |
| `gbe-router.ts` | `dumpGbeRouter` | Walk le singleton `gbe`, lit les `Dictionary<Type, gab<X>>` via probe défensif (anti-zombie), retourne mapping `MessageType → handler info` |
| `gbe-probe.ts` | `installGbeProbe`, `getGbeProbeStats`, `clearGbeProbeStats` | Probe silencieuse (no-log-per-call) sur les entry points `gbe.bidi/kvj/jsl/iad/otz/bidj`. Default = juste `bidi` (1 hook). Compteur per-typeName |
| `attributes.ts` | `getClassAttributes`, `findClassesByAttribute`, `dumpClassAttributesBulk` | Lit les CustomAttributes via `System.Type.GetCustomAttributes()` (pas l'API IL2CPP de bas niveau, simplement reflection .NET) |
| `datacenter.ts` | `listDataRoots`, `dumpDataRoot` | Énumère les `*DataRoot` (statique, sans `gc.choose` flood) ; dumpDataRoot fait `gc.choose` ciblé × 1 puis enumère les ids |

### Drivers Node ajoutés (3)

- `scripts/sentry-collect.js` (install/stats/dump/clear)
- `scripts/dump-gbe-router.js`
- `scripts/dump-datacenter.js` (default set ou single root)

Tous tournent via `PORT=3001 node …` et écrivent dans `.toolkit-data/<module>/`.

### Résultats runtime (PID Dofus attaché en gameplay réel)

| Métrique | Observation |
|---|---|
| `installSentryHooks` | 4/8 overloads installées (les autres absentes runtime). **0 entries collectées** sur 22 minutes — Ankama configure Sentry errors-only, AddBreadcrumb pas appelé en gameplay normal |
| `dumpGbeRouter` | 1/4 dispatchers peuplés : **`dqin/gbb` 700+ entries** (bus d'events `Core.Engine.Messages` locaux). Le dispatcher protobuf RECEIVE (`dqio/gbc`) reste vide même après login + combat → handlers réseau s'enregistrent ailleurs. À investiguer |
| `installGbeProbe(bidi)` | **3646 calls / 109 message types distincts** sur 22 min, dont **59 nouveaux types apparus uniquement pendant un combat** (combat-only payloads) |
| `getClassAttributes` | Fonctionne (39 694 classes scannées en 3 s), mais runtime metadata **pauvre** : 0 `[DoNotRename]`, 0 `[Obfuscation]`, 0 `[LuaCallCSharp]`, 30+ `[GeneratedCode]`, 4 `[Preserve]`. OPS strip la majorité au build → l'index Cpp2IL offline reste plus complet |
| `dumpDataRoot` × 17 | **~57 000 entries de game data dumpées en 60 s** (Items 17 737, Spells 13 640, Monsters 5083, Quest objectives 15 546, Achievements 2620, Effects 859, Item sets 918, etc.) Persisté dans `.toolkit-data/datacenter/` |

**Piste invalidée** : **XLua** (piste #6 originale). `XLua_Gen_Initer_Register__.Init` est de length 0x3 (vide), 0 classes annotées `[LuaCallCSharp]` ou `[ReflectionUse]`. XLua n'est pas activement utilisé dans le client.

### Voie A2 — Cross-ref Dofus 2 (legacy AS3)

Hypothèse : Dofus 3 dérive directement du protocole Dofus 2 (Java/AS3). En matchant les signatures structurelles, on peut résoudre les messages restants.

- ✅ **Repos clonés** : `scalexm/DofusInvoker` (2019) + `HadesFR/DofusInvoker` (2020-12) dans `dofus-app/data/external/dofus2-invoker-{scalexm,hades}/`
- ✅ **Parser AS3** opérationnel : `parse-dofus2-protocol.py` extrait **1068 messages + 324 types** avec 100% protocolId
- ✅ **3 versions du matcher** livrées : v0 (sig brute), v1 (sub-sig depth 1), v2 (collapse i32==i64, f32==f64)
- 📊 **Résultat honnête final** : sur 1323 messages D3, le matcher v2 sort 9 vraies matches **bidirectionnelles 1↔1** seulement
- ⚠️ **Faux positifs structurels** : le matcher peut conclure `igf=GameFightStartMessage` + `igm=Idol` parce que les sigs collent, mais **les Idoles n'existent plus en Dofus 3**. Les matches structurels doivent être audités contre une connaissance des features réellement présentes en Dofus 3 (idoles supprimées, possiblement d'autres mécaniques aussi). **Voir `voie-a-proto-name-matching.md` pour la suite**.

| Métrique | Valeur |
|---|---|
| Messages D2 parsés (AS3) | 1068 |
| Types D2 parsés | 324 |
| **Vraies matches 1↔1 bidirectionnelles (v2)** | **9** |
| Matches retirés après audit "feature morte" | 2 (igf, igm) |
| Confidence "très haute" | `ksj = GameFightPlacementPossiblePositions` (43 calls runtime captés pile pendant phase placement) |

### Outputs session 7

- 5 modules Frida + 3 drivers Node
- Scripts Python : `parse-dofus2-protocol.py`, `match-dofus2-against-current.py` (v0), `match-dofus2-against-current-v1.py`, `match-dofus2-against-current-v2.py`
- Données : `dofus-app/data/external/dofus2-protocol.json` (1392 classes), `dofus-app/data/indexed/dofus2-match-v{0,1,2}.json`, `dofus-app/data/indexed/dofus2-true-perfect-matches.json`, `.toolkit-data/datacenter/*.json` (17 catalogues, ~13 MB), `.toolkit-data/gbe-router/run-*.json`

### Leçons opérationnelles (sauvegardées en mémoire claude)

1. **Ne jamais** appeler `Il2Cpp.gc.choose(klass)` en boucle (ex : pour chaque DataRoot trouvée). Walk du heap × N = freeze garanti du jeu sous gameplay actif. Faire 1 `gc.choose` ciblé par RPC.
2. **`gbe-probe`** : default minimal (bidi seulement) suffit. Activer les 5 forwarders en plus ajoute de l'overhead par appel ; à n'utiliser qu'en gameplay très léger.
3. **Sentry** chez Ankama est errors-only — espérer des breadcrumbs descriptifs en gameplay normal est une perte de temps (0 hits sur 22 min). Reste utile en cas de crash spontané.
4. **Matching D2↔D3 pur structurel a un plafond** dur (~10 vraies matches sur 1300). Pour aller au-delà il faut intégrer (a) un blacklist des features supprimées en D3, (b) une propagation graph-based via les sub-messages déjà nommés, (c) la validation runtime via `armFullCapture`.

## État final après les 7 sessions

| Métrique | Valeur | Session |
|---|---|---|
| Classes obfusquées labellisées | **~110** | 1-3 |
| Méthodes async avec nom | 514 | 3 |
| Méthodes avec **signature complète** | **318** | 3 |
| Messages Protobuf avec schéma | **1323** | 3 |
| Fields Protobuf avec tag+type | **5462** | 3 |
| Handler hits Core | 3203 | 1 |
| Distinct dispatcher classes | 256 | 1 |
| Messages identifiés (clear handlers) | 17 | 1 |
| Dispatcher classes labellisées par cascade | 30 | 1 |
| **Fichiers `.proto` du protocole identifiés** | **99** | **4** |
| **Types indexés avec RVA + Token + FieldOffset** | **7600** | **5** |
| **Méthodes avec RVA native (hookable Frida directe)** | **89 081** | **5** |
| **Classes protoc-generated identifiées** | **1442** | **5** |
| **Méthodes `obf → original_name → RVA`** | **479** | **5** |
| **Messages `.proto` nommés (haute conf)** | **44** (17 + 27) | **6** |
| **Messages avec candidate set** | **744** | **6** |
| **Catalogue Ankama de noms canoniques** | **1284** | **6** |
| **Modules Frida runtime ajoutés** | **5** (sentry/gbe-router/gbe-probe/attributes/datacenter) | **7** |
| **Game data DataCenter dumpée** | **~57 000 entries** (Items, Spells, Monsters, Quests, ...) | **7** |
| **Message types runtime capturés en gameplay** | **109 distincts** (3646 calls, dont 59 combat-only) | **7** |
| **Classes Dofus 2 (AS3) parsées** | **1392** (1068 msgs + 324 types) | **7** |
| **Vraies matches D3↔D2 bidirectionnelles 1↔1** | **9** (v2 matcher) | **7** |
| **Confidence très haute (sig + runtime)** | 1 (`ksj = GameFightPlacementPossiblePositions`) | **7** |

### Progression globale

| Avant sessions 4-5-6 | Après 4-5-6 | Après session 7 |
|---|---|---|
| ~25 % | ~45 % | **~50 %** (runtime probes + DataCenter ajoutés ; matching D3↔D2 plafonne) |

**Plafond pratique atteignable** : ~65 % (les noms originaux strippés sont irréversibles). Donc on est à **~75 % du plafond**.

**RPC custom** dans `explorer.ts` (9 nouvelles fonctions) :
- ✅ `dumpAssemblyShape`, `buildProtoHandlerMap`, `installCodedInputSniffer`, `getCollectedProtoData`
- ⚠️ `dumpCompilerGenLeaks` (bug : 1 entry — workaround Python OK)
- ❌ `harvestProtoSchema`, `dumpProtobufFileDescriptors`, `dumpStaticByteArrays`, `installProtoNameSniffer`, `installParseFromSniffer` (échecs runtime, FileDescriptor non initialisé)
- 🚨 Les sniffers intercept-tout ont **crashé le PC** en gameplay actif — préférer désormais les hooks par RVA précise (session 5).

## Pistes restantes (priorité descendante après session 7)

1. **Matcher D2↔D3 v3 graph-based** : utiliser les ~770 noms D3 déjà connus (proto-name-mapping-v2 + 17 clear-handlers + 9 sig-1↔1 audités) comme **ancres** dans un graphe. Pour chaque D3 inconnu, chercher les D2 dont les sub-messages référencés ont les mêmes labels que les sub-messages D3 nommés. Devrait débloquer plusieurs centaines de matches. **+ blacklist features mortes** (Idoles confirmées, à compléter). ~2-3 jours. **Voir `voie-a-proto-name-matching.md` pour le plan détaillé**.
2. **`armFullCapture` sur messages combat** (`igf`, `jus`, `jac` en cours d'audit, plus les 56 nouveaux types runtime non identifiés). Capture la structure ET les valeurs réelles → invalidation/confirmation par contenu sémantique (un field xpBonusPercent confirme/infirme une hypothèse Idol-related). ~30min par capture.
3. **Bucketing alphabétique par fichier `.proto`** — OPS Obfuscator nomme dans l'ordre de déclaration. Connaissant nos 99 modules, on peut **partitionner les 1323 obf names dans les 99 buckets** par proportion. Combiné aux 27 high-confidence + 9 sig-1↔1 + propagation, monterait à 60-70 % du protocole nommé. ~1h.
4. **Localiser le vrai dispatcher protobuf RECEIVE** : `gbe.dqio/gbc` reste vide en gameplay → les handlers se loggent ailleurs. Tracer manuellement où `gbe.bidi(Type, IMessage, …)` route les messages reçus → trouver la map qui se peuple effectivement. ~1-2h.
5. **#10 — Rename layer dans le toolkit** : `frida-rename-table.json` est prêt à être consommé. Hook côté Frida sur `Il2Cpp.Class.name` retourne le nom déobfusqué (label + real_proto_name) quand connu. UX énorme mais cosmétique — **à faire en dernier**, voir [`feedback_rename_last`](../../.claude/projects/f--FridaIL2CPPToolkit/memory/feedback_rename_last.md).
6. **Re-run session 6 quand source ModulX/LuaxY plus récente est dispo** — passif, pas d'effort, mais peut multiplier le ratio par 2.

### Pistes invalidées / dépriorisées

- ❌ **XLua bindings** (#6 originale) — XLua non utilisé activement dans Dofus 3 (Init de length 0x3, 0 attrs LuaCallCSharp). Confirmé en session 7.
- ❌ **Sentry breadcrumbs** (#8 originale) — Ankama configure le SDK errors-only, AddBreadcrumb pas appelé en gameplay normal (0 entries sur 22 min). Reste armé au cas où le client crashe.
- 🟡 **CustomAttributes runtime** — module livré et fonctionnel (39k classes scannées en 3 s), mais OPS strip la majorité des attrs custom au build. L'index Cpp2IL offline reste le bon endroit pour ça.

---

## Pistes initiales (originales, gardées pour référence)

---

## Outputs attendus

À la fin de la session :
- 📄 `dofus-app/docs/deobfuscation-map.md` — étendue (~150 classes identifiées vs 75 actuellement)
- 📄 `dofus-app/docs/protocol-handlers.md` — nouveau, table `MessageType → handler obfusqué`
- 📄 `dofus-app/docs/gbe-routing-table.md` — nouveau, dump du routing Protobuf runtime
- 📄 `dofus-app/data/deobfuscation/*.json` — données structurées pour réutilisation

## Notes techniques

- API host : `POST http://localhost:3000/api/call` `{method, args}` → proxy Frida RPC
- Process attaché : `Dofus.exe`
- Bug connu : RPC custom `dumpCompilerGenLeaks` retourne 1 entry au lieu de 583 (à investiguer mais workaround OK : post-processing Python sur `dumpAssemblyShape`)
- Tous les dumps bruts vont dans `%TEMP%/shape_*.json`
