# Dofus 3.0 — Reverse de l'obfuscation : synthèse finale

> Synthèse de l'ensemble du travail de déobfuscation (runtime Frida + offline Cpp2IL).

## TL;DR final

**L'obfuscation Dofus 3.0 est très largement réversible** par la combinaison de **9 vecteurs de leak** (6 originaux + 3 ajoutés en sessions 4-5), dont 4 récupérables au runtime et 5 supplémentaires offline via Cpp2IL + ilspycmd. La conclusion principale : **les noms originaux des classes/méthodes sont définitivement perdus** (le metadata IL2CPP a été obfusqué au build), mais **les signatures, structures et adresses natives sont entièrement récupérables**, suffisamment pour reconstruire le rôle de chaque classe, le schéma .proto complet, et hooker précisément n'importe quelle méthode via Frida sans recherche par nom.

| Vecteur | Comment | Données récupérées |
|---|---|---|
| 1. Compiler-gen async closures | Le nom des state machines `<Method>d__N` est préservé | **514 noms de méthodes originaux** dans Core |
| 2. Async state machine fields (offline) | Les fields des state machines = **paramètres originaux** | **318 méthodes avec signature complète** (params + types) |
| 3. Survived names (`[DoNotRename]`) | Classes/services nommés conservés | **2229 classes claires** |
| 4. Inheritance | Les enfants clairs révèlent le domaine du parent | 14 bases obfusquées identifiées (UI, SpellZoneShape, etc.) |
| 5. Type references | Système de types préservé → leak via Protobuf/HAAPI/FMOD/etc | **Forte triangulation** sur 110+ classes |
| 6. Protocol handler topology | `void Handle(SomeProtoMsg)` mappe handler → message | **3203 handler hits** sur 1443 messages |
| 7. Protocol schema (offline) | Les const int = tags Protobuf, types préservés | **1323 messages × 5462 fields avec tag+type** |
| 8. **Source paths dans metadata IL2CPP** *(session 4)* | Le metadata expose les paths Unity Package → noms `.cs` source | **99 fichiers `.proto` du protocole identifiés** par nom |
| 9. **Cpp2IL `attributeanalyzer/injector`** *(session 5)* | Les DLLs enrichies portent `[Token] [Address(RVA)] [FieldOffset] [GeneratedCode("protoc"]` | **89 081 méthodes avec RVA native + 5228 fields avec offset C++ + 1442 classes protoc-generated identifiées** |
| 10. **AsyncStateMachine attribute** *(session 5)* | `[AsyncStateMachine(typeof(_003C<RealName>_003Ed__N))]` révèle le vrai nom de la méthode obfusquée | **479 méthodes mappées `obf_name → original_name → RVA`** |
| 11. **Match structurel vs Dofus 2 community .proto** *(session 6)* | Signatures Protobuf préservées entre versions Ankama → match auto vs ModulX/dofus-unity-proto | **27 noms `.proto` haute confiance + 744 candidate sets + 1284 noms canoniques** |

## L'obfuscateur : OPS Obfuscator

Détecté via l'assembly `OPS.Obfuscator` (12 classes). Schéma de renommage **alphabétique simple** (`a`, `b`, ..., `aa`, `ab`, ..., `ba`, ..., `xyz`). Pas d'unicode, pas de control-flow flattening agressif. Renomme :
- ✅ Classes (4431 sur 6694 du root namespace de Core)
- ✅ Méthodes
- ✅ Fields
- ✅ Namespaces (Protocol.Game retombe au namespace racine)
- ❌ Pas de string encryption visible
- ❌ Pas de tampering avec les types système ou les compiler-gen

**Markers OPS** :

| Attribute | Effet |
|---|---|
| `DoNotRenameAttribute` | nom original conservé |
| `DoNotObfuscateClassAttribute` | classe entière exclue |
| `DoNotObfuscateMethodBodyAttribute` | corps lisible |
| `DoNotUseClassForFakeCodeAttribute` | exclut de l'injection de fake code |
| `ObfuscateAnywayAttribute` | force l'obfuscation |
| `NotObfuscatedCauseAttribute` | doc interne du *pourquoi* |

(Ces markers sont strippés du binaire final mais leur structure révèle ce que l'obfuscateur peut faire.)

## Pipeline complet utilisé

```
[Live Dofus.exe]
       │
       ├─► Frida + frida-il2cpp-bridge
       │   └─► RPC custom (explorer.ts, +9 nouvelles fonctions)
       │       ├─ dumpAssemblyShape       — squelette de chaque assembly
       │       ├─ dumpClassAsString       — fields/methods d'une classe (105 classes dumpées)
       │       ├─ dumpCompilerGenLeaks    — extraction des `<Method>d__N`
       │       ├─ buildProtoHandlerMap    — scan des handlers de chaque message
       │       ├─ harvestProtoSchema      — tentative descriptor (échec, lazy init)
       │       ├─ dumpProtobufFileDescriptors — idem
       │       ├─ installProtoNameSniffer — hook FromGeneratedCode (jamais appelé)
       │       ├─ installParseFromSniffer — hook ParseFrom (jamais appelé)
       │       └─ installCodedInputSniffer — hook ReadMessage ✓ (24 hits captés)
       │
[Files on disk]                       
       │
       ├─► Cpp2IL (Windows release pre-21)
       │   └─► dummy DLLs avec types + signatures complètes
       │
       └─► ilspycmd (dotnet tool)
           └─► 5998 fichiers .cs avec
               • signatures complètes
               • async state machines (paramètres préservés)
               • héritage / interfaces
               • usings (types publics référencés)
               • const int (= tags Protobuf)
```

## Résultats par catégorie

### Stats globales

| Métrique | Valeur | Session |
|---|---|---|
| Classes obfusquées identifiées avec confiance | **~110** dans la table principale | 1-3 |
| Méthodes async avec nom original récupéré (Core) | **514** | 3 |
| Méthodes async avec signature complète (params + types) | **318** | 3 |
| Messages Protobuf avec schéma extrait | **1323** | 3 |
| Fields Protobuf avec tag+type | **5462** | 3 |
| Handler hits dans Core | **3203** | 1 |
| Distinct dispatcher classes | **256** | 1 |
| Messages identifiés via clear handlers | **17** | 1 |
| Classes obfusquées labellisées par cluster cascade | **30** | 1 |
| **Fichiers `.proto` du protocole identifiés** | **99** | **4** |
| **Types indexés Cpp2IL avec Token+RVA+FieldOffset** | **7600** (5992 Core + 1608 Protocol.Game) | **5** |
| **Méthodes avec RVA native dans GameAssembly.dll** | **89 081** (100 %) | **5** |
| **Classes Protobuf-generated identifiées sans ambiguïté** | **1442** | **5** |
| **Méthodes mappées `obf_name → original_name → RVA`** | **479** (via [AsyncStateMachine] leak) | **5** |
| **Fields avec FieldOffset C++ exact** | **5228** | **5** |
| **Messages `.proto` nommés (haute confiance)** | **44** (17 + 27 via match Dofus 2 community) | **6** |
| **Messages `.proto` avec candidate set (1-10 candidats)** | **744** | **6** |
| **Catalogue Ankama de noms `.proto` canoniques disponible** | **1284** (via ModulX/dofus-unity-proto) | **6** |

### Top identifications (haute confiance)

| Score | Obf | Identité | Source d'évidence |
|---|---|---|---|
| 198 | `fpz\`1` | **UI base class générique** | 196 sous-classes nommées (toutes les `*UI`/`*Ui`) |
| 94 | `eat` | **Cartography view** | méthodes `LoadCartographyImages, AddAreaShape` + types `WorldMapData` + sous-classes `CartographyMapView` |
| 82 | `fdy` | **Entity factory rendering** | méthodes `Generate*Character` + types `Entity, EntityLook` |
| 60 | `els` | **Audio manager (FMOD)** | méthodes `DoLoadBank, InitializeAudioManager` + types `FMOD.Studio.EventInstance, AudioManagerLibrary` |
| 57 | `eah` | **Worldmap UI** | méthodes `MoveToWorldmapMenuElement` + types `SubAreaData/DungeonData/HintData` |
| 56 | `egq` | **HAAPI client (Ankama+Dofus)** | 17 méthodes (`ConsumeKardByCode(code,lang)`, `CreateTokenWithPassword(account,password,game)`, etc.) + types `HaapiAnkama.Model.{Token,Almanax,KardKard,MoneyOgrine,BakBid}` |
| 48 | `uf` | **Entity factory** | `GenerateCharacter(look,ownerCollectorId,entityId,cellId,parent,isVisible,...)` + types `Core.Rendering.Entity.*` |
| 43 | `emb` | **Shopi (Boutique) client** | `CreateCart, CreateOrder, GetShopCatalog` + types `Com.Ankama.Shopi.Model.*` |
| 40 | `dxd` | **Protocol dispatcher (Inventory)** | 75 messages handled, refs `Core.UILogic.Inventory.Inventory` |
| 14 | `ghn` | **SpellZoneShape behavior base** | 14 sous-classes `SpellZoneShape{Boomerang,Cone,Cross,...}Behavior` |

(Liste complète dans [`deobfuscation-map.md`](./deobfuscation-map.md))

### Topologie protocole

- **1323 message classes** Protobuf avec schéma complet (tags + types) extraits offline
- **`gui` est l'envelope universelle** (2 fields : `object` payload + `guh` enum case → c'est un **oneof wrapper**)
- **17 messages identifiés par clear-name handlers** :
  - `khe` (132 fields) → FightEntity event (handled by `FightEntitiesService`)
  - `khn` → Inventory event
  - `iyy`/`izc` → BuffsFight event
  - `iso` → Roleplay intro event
  - `jno` → EndTurn event
  - `kaz` → MarkedCells
  - `jsg` → MapDisplay
  - etc.

### Ce qui reste obfusqué et pourquoi

- **Les noms `.proto`** : OPS Obfuscator a strippé les noms du metadata IL2CPP. Le `FileDescriptor` n'est jamais initialisé par Dofus (custom Protobuf path qui bypass la reflection). Le binaire `byte[]` du FileDescriptorProto est lui aussi stripé du build final. **Récupération directe impossible** — confirmé exhaustivement (cf. `proto-descriptor-extraction.md`).
- **Les noms de classes/méthodes/fields obfusqués** : perdus dans le metadata. La signature est récupérable mais le NOM original ne l'est pas, sauf si l'obfuscateur l'a préservé via attribute (cas pour ~25% des classes) ou via les leaks compiler-gen `[AsyncStateMachine]`.
- **Les fake classes injectées par OPS** : non distinguables sans accès aux CustomAttributes (qui sont strippés du binaire final). À noter : Cpp2IL `attributeanalyzer/injector` reconstruit les attributs runtime standards (`[GeneratedCode]`, etc.) mais pas les attributes OPS custom.

### Pour récupérer les noms `.proto`

Solution **mise en œuvre** (session 6) : **matching structurel** contre les `.proto` Dofus Unity reverse-engineered par la communauté ([ModulX/dofus-unity-proto](https://github.com/ModulX/dofus-unity-proto), 80 .proto + 1285 mappings). Limité par la divergence de versions (Aug 2024 vs notre snapshot) → **27 confirmed + 744 candidate sets**. Détails : [`voie-a-proto-name-matching.md`](./voie-a-proto-name-matching.md).

## Outputs produits

### Documentation
- [`dofus-deobfuscation.md`](./dofus-deobfuscation.md) — TL;DR principal
- [`dofus-deobfuscation-roadmap.md`](./dofus-deobfuscation-roadmap.md) — pistes faisables, état d'avancement
- [`dofus-deobfuscation-final.md`](./dofus-deobfuscation-final.md) — **ce doc** (synthèse finale)
- [`deobfuscation-map.md`](./deobfuscation-map.md) — table générée auto (110+ classes)
- [`protocol-handlers.md`](./protocol-handlers.md) — topologie statique (1443×256)
- [`protocol-runtime-observations.md`](./protocol-runtime-observations.md) — captures live runtime
- [`proto-schema-decompiled.md`](./proto-schema-decompiled.md) — schéma .proto complet (1323 messages)
- [`decompiled-leaks.md`](./decompiled-leaks.md) — signatures de méthodes recovered
- [`proto-descriptor-extraction.md`](./proto-descriptor-extraction.md) — *(session 4)* tentative d'extraction byte[] FileDescriptor + découverte des 99 .proto via metadata
- [`cpp2il-attribute-index.md`](./cpp2il-attribute-index.md) — *(session 5)* indexation Cpp2IL avec attribut Token/RVA/FieldOffset
- [`voie-a-proto-name-matching.md`](./voie-a-proto-name-matching.md) — *(session 6)* matching structurel vs ModulX/dofus-unity-proto

### Données structurées (JSON)
- [`deobfuscation-map.json`](./deobfuscation-map.json)
- [`protocol-handlers.json`](./protocol-handlers.json)
- [`protocol-message-labels.json`](./protocol-message-labels.json) — 17 messages labellisés
- [`protocol-runtime-observations.json`](./protocol-runtime-observations.json)
- [`proto-schema-decompiled.json`](../data/proto-schema-decompiled.json) — schéma complet
- [`decompiled-class-info.json`](../data/decompiled-class-info.json) — info par classe
- [`data/protocol/proto-source-files.json`](../data/protocol/proto-source-files.json) — *(session 4)* 99 fichiers `.proto` du protocole
- [`data/indexed/core.classes.json`](../data/indexed/core.classes.json) — *(session 5)* index complet Core (5992 types, 34 MB)
- [`data/indexed/protocol-game.classes.json`](../data/indexed/protocol-game.classes.json) — *(session 5)* index complet Protocol.Game (1608 types)
- [`data/indexed/deobmap-enriched.json`](../data/indexed/deobmap-enriched.json) — *(session 5)* deob map + RVA pour 256 méthodes
- [`data/indexed/frida-rename-table.json`](../data/indexed/frida-rename-table.json) — *(sessions 5-6)* **table compacte de rename pour Frida** (402 classes + 479 méthodes hookables par RVA)
- [`data/indexed/proto-name-mapping-v2.json`](../data/indexed/proto-name-mapping-v2.json) — *(session 6)* résultat du matcher proto
- [`data/external/dofus-unity-proto/`](../data/external/dofus-unity-proto/) — *(session 6)* clone ModulX (80 .proto + mappings)

### Scripts (reproductibles)
- `build-deobfuscation-map.py` — orchestrateur principal, agrège toutes les sources
- `build-protocol-handlers.py` — topologie statique des handlers
- `extract-decompiled-leaks.py` — leaks depuis IL décompilé
- `extract-proto-schema-from-decompiled.py` — schéma Protobuf depuis IL
- `collect-proto-names.py` — décodeur Frida (ne sert plus, FileDescriptors lazy)
- `extract-proto-descriptors-from-dll.py` — *(session 4)* scanner FileDescriptorProto (résultat : 0, confirme strip)
- `extract-proto-source-names.py` — *(session 4)* extracteur des 99 .proto names depuis metadata
- `index-cpp2il-attrs.py` — *(session 5)* parser principal des .cs Cpp2IL enrichis
- `enrich-deobmap-with-rva.py` — *(session 5)* cross-ref deob map ↔ index
- `build-frida-rename-table.py` — *(session 5)* produit la rename table Frida
- `match-proto-against-modulx.py` / `match-proto-v2.py` — *(session 6)* matching contre ModulX
- `integrate-proto-mapping.py` — *(session 6)* merge dans rename-table

### RPC Frida (`src/rpc-agent/explorer.ts`)
9 nouvelles fonctions ajoutées : `dumpAssemblyShape`, `dumpCompilerGenLeaks`, `buildProtoHandlerMap`, `harvestProtoSchema`, `dumpProtobufFileDescriptors`, `dumpStaticByteArrays`, `installProtoNameSniffer`, `installParseFromSniffer`, `installCodedInputSniffer`, `getCollectedProtoData`.

## Bilan opérationnel

**Travail utile pour la suite** :
- ✅ La déobfusc map peut servir de base pour étiqueter les classes dans le toolkit (rename layer #10)
- ✅ Le schéma protocole est utilisable pour écrire un sniffer/parser de paquets Dofus
- ✅ Les signatures recovered (`ConsumeKardByCode(code, lang)`, etc.) permettent de hooker précisément les fonctions clés
- ✅ La topologie handlers permet de cibler les classes par domaine (combat, inventaire, etc.)
- ✅ *(session 5)* **479 méthodes hookables par RVA directe** (`Module.findBaseAddress("GameAssembly.dll").add(rva)`) — pas d'intercept-tout, pas de crash
- ✅ *(session 5)* **5228 fields avec FieldOffset C++** — scan/read mémoire 10× plus rapide via `Memory.read*`
- ✅ *(session 5)* **`[GeneratedCode("protoc"]`** identifie les 1442 classes Protobuf-generated sans ambiguïté
- ✅ *(session 6)* **44 messages `.proto` nommés** + **catalogue de 1284 noms canoniques Ankama** disponible

**Limitations connues** :
- ❌ Noms originaux des classes/méthodes/fields perdus définitivement (sauf via leak compiler-gen / `[DoNotRename]`)
- ❌ Noms `.proto` partiellement récupérés (44 hi-conf + 744 candidate sets, limité par divergence de versions vs sources publiques Aug 2024)
- ❌ Les fake classes OPS non détectables (CustomAttributes strippés)

**Plafond pratique atteignable** : ~65% (cf. analyse de progression). Actuellement à **~45%**. Pour grimper :
- *Bucketing alphabétique par fichier .proto* → +5-10 pts (~1h)
- *Rename layer Frida* → +5 pts UX (1h)
- *Re-run Voie A avec source plus récente quand dispo* → +10 pts (passif)

**Effort total cumulé** : ~10 heures de session sur 6 sessions, ~40 fichiers produits, infra réutilisable pour de futurs reverse Dofus (chaque update du jeu, refaire `Cpp2IL` + scripts en 30 min).

## Session 8 — Multi-path sprint (terminée 2026-04-29, partie offline)

Sprint design : [`docs/superpowers/specs/2026-04-29-deobfusc-sprint-multipath-design.md`](superpowers/specs/2026-04-29-deobfusc-sprint-multipath-design.md).
Plan d'implémentation : [`docs/superpowers/plans/2026-04-29-deobfusc-sprint-multipath.md`](superpowers/plans/2026-04-29-deobfusc-sprint-multipath.md).

**Objectif** : combiner 4-5 nouvelles sources non tentées (AssetRipper bundles, DBI/DDC mapping, hook FileDescriptor par signature, string-refs natif) avec un orchestrateur de merge unifié, pour passer de ~50% à 85-95% du plafond pratique.

### Pipeline mis en place

```
[AssetRipper bundles]      →  data/external/assetripper-monobehaviours.json     [DEFERRED — manual GUI export]
[DBI/DDC source scan]      →  data/external/dbi-name-table.json                 [4098 entries → 38 high_unique]
[protodec --il2cpp]        →  data/external/protodec-rename.json                [SKIPPED — Cpp2IL DLL absent]
[FileDescriptor hook]      →  data/runtime/protobuf-descriptors-captured.json   [DEFERRED — manual Frida session]
[String-refs sweep]        →  data/indexed/string-refs-rename.json              [13 entries → 2 nouveaux labels]
                                              │
                                              ▼
              [merge-rename-table.py orchestrator]
                                              │
                                              ▼
              data/indexed/frida-rename-table.json (étendu)
              data/indexed/merge-conflicts.md
```

### Modules livrés (offline-only, ce qui est exécutable sans Dofus.exe)

| Script | Fonction | Statut |
|---|---|---|
| `_rename_schema.py` | RenameEntry dataclass + read/write_entries | ✅ |
| `parse-assetripper-monobehaviours.py` | parse YAML AssetRipper export | ✅ (parser prêt, export user-side) |
| `parse-dbi-tables.py` | scan .cs DBI/DDC pour noms canoniques | ✅ (4098 entrées émises) |
| `find-filedescriptor-init-rvas.py` | XRefs offline pour candidats init | ✅ (1487 candidats) |
| `proto-descriptor-capture.ts` (Frida) | hook atomique RVA → byte[] dump | ✅ (RPC armé, runtime pending) |
| `capture-proto-descriptors.js` (Node) | driver install → wait → dump | ✅ (prêt, runtime pending) |
| `parse-captured-descriptors.py` | parse byte[] FileDescriptorProto | ✅ (synthetic self-test pass) |
| `extract-stringrefs-classlinks.py` | scan .rdata + XRefs Capstone | ✅ (run réel, 55 s, 13 RenameEntry) |
| `merge-rename-table.py` | orchestrateur 3-phases avec conflits | ✅ (atomic write, fields préservés) |

### Résultats partie offline

| Métrique | Avant sprint | Après sprint offline |
|---|---|---|
| Classes Core nommées (haute confiance) | ~110 | **~110 + 2 nouvelles** = `glc` (display/window manager via Win32 strings) + `hnh` (Win32 ref multi-string) |
| Classes already-clear confirmées via DBI cross-ref | n/a | **38** classes (Entity, Fight, FriendList, DofusIcon, MapTransition, etc.) — corpus de truth |
| Total RenameEntry mergées dans frida-rename-table | n/a | **40 unique obf** (38 high_unique + 2 low_struct_match) |
| Fichiers `.proto` capturés (FileDescriptor hook) | 44 | **44 (deferred au manual session)** |
| Conflits agrégés (logged) | n/a | 2 (Win32 multi-strings) |

**Findings architecturaux importants** (à documenter pour les futures sessions) :

1. **Strings managed dans IL2CPP** : les chaînes de classes/méthodes managées sont stockées dans `global-metadata.dat`, **pas dans `.rdata` de `GameAssembly.dll`**. Le `.rdata` ne contient que des chaînes natives (Unity bindings, Win32 APIs, runtime errors). Le sweep `extract-stringrefs-classlinks.py` ne peut donc capturer que les classes qui INTERFACENT avec du code natif (e.g. la classe display/window via Win32). **Pour passer aux strings managed, il faudrait scanner `global-metadata.dat`** — out of scope ce sprint.

2. **DBI/DDC ne publie pas de mapping `obf → real`** : ils utilisent BepInEx + Il2CppInterop avec interop assemblies générées au build. Les `.cs` source réfèrent directement aux noms canoniques (Entity, Fight, etc.) — utile comme **catalogue de truth labels** pour identifier les already-clear classes, mais pas pour mapper les obf restants.

3. **Index Cpp2IL n'expose pas le `body_excerpt`** des méthodes — uniquement les attributs et signatures. Le filtre des candidats FileDescriptor a dû passer par `is_protoc_generated + return_type=='static' + class_has_FileDescriptor_field`. 1487 candidats, dont 4 named Reflection classes (score 4) + 1483 cctors (score 3).

4. **Cpp2IL DLL output stripped** : Task 4 (protodec --il2cpp pour cross-check) skippé faute de `Protocol.Game.dll` Cpp2IL-dumpé. À re-runner pour réactiver Task 4 sur futures sessions.

### Pistes encore actives (à exécuter en session manuelle)

1. **AssetRipper export GUI** : lancer `C:/Tools/AssetRipper/AssetRipper.GUI.Free.exe`, charger `F:/Jeux/Dofus-dofus3/Dofus_Data/`, exporter les bundles avec scripts off + resources YAML on dans `dofus-app/data/external/assetripper-export/`. Puis re-run `parse-assetripper-monobehaviours.py` + `merge-rename-table.py`. **Gain attendu** : +50 à +500 classes (MonoBehaviour attachés à des prefabs/scenes).

2. **Frida runtime capture** : attacher Frida à `Dofus.exe`, lancer `node dofus-app/scripts/capture-proto-descriptors.js`, login + charger une map. **Gain attendu** : 4 .proto files au minimum (les Reflection classes nommées) ; potentiellement plus si les cctors déclenchent des byte[] reads via partner classes.

3. **Scan `global-metadata.dat`** : nouvelle source non implémentée ce sprint. Les noms managed strings y vivent. Un parser metadata IL2CPP exposerait `LiteralMethodToString → method_index` et permettrait de rejoindre les XRefs natifs. À évaluer en session 9.

### Effort sprint

~3h de session controller + multi-subagent dispatch. ~12 commits. Infrastructure réutilisable : un nouveau vecteur de signal s'intègre via 1 nouveau parser + 1 ligne de source dans `merge-rename-table.py`.

### Plafond pratique recalculé

- Avant sprint : ~50% du plafond pratique (~65%)
- Après sprint offline : ~52% (gains marginaux côté Core, mais infra prête)
- Après session manuelle (AssetRipper + Frida runtime) : projection **~70-80%** si AssetRipper donne ≥200 MonoBehaviours et Frida capture ≥30 .proto descriptors
