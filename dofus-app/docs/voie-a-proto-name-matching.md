# Dofus 3.0 — Voie A : matching structurel des messages .proto

> Tentative de récupérer les **vrais noms `.proto`** des 1323 messages
> obfusqués en matchant leur signature `(field_count, [(tag, wire_type)])`
> contre des `.proto` Dofus Unity reverse-engineered publiés par la
> communauté.

## TL;DR

Trois repos publics ont été identifiés :
- [`ModulX/dofus-unity-proto`](https://github.com/ModulX/dofus-unity-proto) — **80 .proto + mapping `obf_v_old → name`** (1285 entrées)
- [`LuaxY/dofus-unity-protocol-builder`](https://github.com/LuaxY/dofus-unity-protocol-builder) — 79 .proto + descriptors JSON (Aug 2024)
- [`RuinedYourLife/dofus-deobfs`](https://github.com/RuinedYourLife/dofus-deobfs) — outil Go qui automatise le matching

**Résultats** (avec ModulX comme reference) :
| Métrique | Valeur |
|---|---|
| .proto files reference | 80 (vs nos 99 → 74 partagés) |
| Reference messages | 1525 (vs nos 1323) |
| **High-confidence matches (signature 1:1 unique)** | **27** |
| **Ambiguous (≥1 candidate, listed)** | **744** |
| Unmatched (sig non trouvée chez ref) | 552 |
| Catalog ModulX de noms canoniques | 1284 noms uniques |

**Pourquoi seulement 27 confirmés** : les .proto publics (Aug 2024) sont
**d'une version Dofus 3 antérieure** à la nôtre. Ankama préserve le wire
format mais ajoute / modifie / déplace des fields à chaque update. Sur 1323
messages chez nous : 25 nouveaux modules entiers (`guild_mission_*`,
`ladder_*`, `world_event`, etc. — voir diff dans `proto-source-files.json`)
+ modifs internes des messages existants → la majorité des signatures ne
matchent plus exactement.

**Le vrai gain** : on a maintenant **1284 noms canoniques de messages
Protobuf Dofus** comme catalogue de référence (dans
`frida-rename-table.json` sous `references.modulx_v_old_obf_to_name`),
même sans le mapping direct.

## High-confidence matches (27)

Tous obtenus par **signature unique non-triviale** côté ref :

| Obf | Real name | .proto | Confidence |
|---|---|---|---|
| `gxf` | SkillAction | job.proto | high_unique_sig |
| `gzp` | ChallengeTarget | common.proto | high_unique_sig |
| `hbl` | SpellsEvent | spell.proto | high_unique_sig |
| `hca` | ArenaUpdatePlayerInformationEvent | arena.proto | high_unique_sig |
| `hcq` | LeaderPositionEvent | party.proto | high_unique_sig |
| `hfz` | GuildChestTabContributionEvent | guild_chest.proto | high_unique_sig |
| `hlb` | PlayerFlowActivity | common.proto | high_unique_sig |
| `hll` | ObjectItemInventory | common.proto | high_unique_sig |
| `hvp` | SelfAttackableStatusUpdateEvent | social.proto | high_unique_sig |
| `hwz` | HousePropertiesEvent | house.proto | high_unique_sig |
| `hyf` | OutfitCreateEmptyRequest | cosmetic.proto | high_unique_sig |
| `hyo` | ExchangeObjectsModifiedEvent | exchange.proto | high_unique_sig |
| `ibm` | FightTeamMembersInformation | common.proto | high_unique_sig |
| `idm` | ObjectPriceDateEffect | common.proto | high_unique_sig |
| `jbm` | DelayedActionEvent | roleplay.proto | high_unique_sig |
| `jgl` | VotedChoice | choice.proto | high_unique_sig |
| `jnp` | FightTurnListEvent | fight.proto | high_unique_sig |
| `jox` | MonsterGroupStaticInformation | common.proto | high_unique_sig |
| `jsv` | ArenaFightPropositionEvent | arena.proto | high_unique_sig |
| `jur` | PaddockTransactionDialogEvent | paddock.proto | high_unique_sig |
| `jxe` | ChallengeListEvent | challenge.proto | propagation_iter1 |
| `kky` | AchievedAchievement | achievement.proto | high_unique_sig |
| `kle` | Challenge | common.proto | high_unique_sig |
| `klx` | BakBuyValidationEvent | bak.proto | high_unique_sig |
| `kst` | CharacterUpdatedBreedEvent | appearance.proto | high_unique_sig |
| `ktm` | NpcWithQuest | npc.proto | high_unique_sig |
| `kwa` | ObjectUseOption | common.proto | high_unique_sig |

### Cross-check vs. nos labels existants

Notre `idm` était inféré comme `WatchEquipmentUI` (via les handlers UI qui
le consomment). Le matcher dit `idm = ObjectPriceDateEffect`. **Les deux
sont vrais** :
- `ObjectPriceDateEffect` = nom du **message Protobuf** (le payload réseau)
- `WatchEquipmentUI` = nom du **handler côté client** qui le consomme

Les deux infos sont complémentaires.

## Méthodologie

### Pipeline

```
1. Clone ModulX/dofus-unity-proto             → 80 .proto + mappings JSON
2. protoc --descriptor_set_out=…              → FileDescriptorSet binaire
3. extract signatures of every reference msg  → (n_fields, [(tag, type)])
4. extract signatures of every OUR msg        → idem (depuis proto-schema-decompiled)
5. normalize C# types → Protobuf wire-types unifiés (clé : token "OPAQUE"
   pour tout sub-message/enum afin de matcher cross-version)
6. bucket-match: for each non-trivial sig, if exactly 1 ref has it → confirmed
7. propagate via sub-message references for ambiguous
```

### Trois pièges évités

1. **Faux positifs sur signatures triviales** (1 field int, 2 fields int+bool,
   etc.) — filtrés via `is_trivial_signature()`.
2. **Mismatch MESSAGE / ENUM** entre côtés — unifiés en `OPAQUE` car ni
   notre côté (sub-message obfusqué) ni le côté ref (avec type_name) ne
   peuvent produire un token comparable strictement.
3. **Multi-mapping vers le même nom** (`OutfitEquipObjectBestSlotResponse`
   apparaissant 4× en v1) — corrigé en exigeant qu'un seul ref ait la
   signature, avec collisions côté nous traitées comme ambigu.

## Outputs

- [`scripts/match-proto-against-modulx.py`](../scripts/match-proto-against-modulx.py) — matcher v1 (signature+compat)
- [`scripts/match-proto-v2.py`](../scripts/match-proto-v2.py) — matcher v2 (1:1 strict + propagation)
- [`scripts/integrate-proto-mapping.py`](../scripts/integrate-proto-mapping.py) — merge dans rename-table
- [`data/indexed/proto-name-mapping-v2.json`](../data/indexed/proto-name-mapping-v2.json) — résultats détaillés
- [`data/indexed/proto-mapping-summary.json`](../data/indexed/proto-mapping-summary.json) — résumé
- [`data/indexed/frida-rename-table.json`](../data/indexed/frida-rename-table.json) — **rename table mise à jour** (+ 27 noms .proto + 744 candidate sets + catalogue ModulX)
- [`data/external/dofus-unity-proto/`](../data/external/dofus-unity-proto/) — clone complet de ModulX

## Pourquoi le rendement est limité

| Cause | Impact | Mitigation |
|---|---|---|
| Versions divergentes (notre snapshot vs Aug 2024) | -50% des matches | Re-run quand source plus récente |
| 25 modules `.proto` neufs chez nous | 0 matches possibles dans ces fichiers | Out of scope |
| Ankama refactor des messages existants | Sigs changent → matchs perdus | Auto-relax (fuzzy match ±1 field) |
| Signatures triviales (1-3 fields primitifs) | 50% du protocole "ambigu" | Propagation graphe sub-message |

## Ce qui reste possible

### Court terme (gains rapides)

1. **Fuzzy signature matching** (±1 field, swap tags) — gagnerait peut-être +50 confirmed
2. **Propagation plus aggressive** : seed avec les 27 confirmed + nos 17 known labels (clear-handlers) + le mapping ModulX dans son entièreté → 5-10 itérations
3. **Bucketing par fichier** : si OPS Obfuscator nomme dans l'ordre alphabétique des fichiers source (probable), on peut **partitionner les 1323 obf names dans les 99 buckets `.proto`** par proportion. Donne le bucket pour 100% du protocole. Combiné aux signatures, monte le confirm rate à 60-70%.

### Moyen terme

4. **Dump le client Dofus 3 d'une autre époque** (back-up de version) où
   OPS aurait été désactivé temporairement, ou où certains symbols seraient
   restés clear par bug — improbable mais possible.
5. **Mining des breadcrumbs Sentry au runtime** — les paths logged par
   Sentry contiennent souvent des noms de classes Protobuf clear.
6. **Proxy MITM (Fiddler/mitmproxy avec décrypto TLS Bouncy Castle)** —
   capturer du trafic réel + cross-ref avec un client open-source actif
   (kralamoure et autres).

### Long terme

7. Maintenir une **table de mapping versionnée** dans le toolkit qui se
   régénère à chaque update Dofus, en combinant tous les vecteurs (compiler-
   gen leak, type ref leak, handler topology, signature match).

## Bilan global de la déobfusc avec Voie A

| Avant Voie A | Après Voie A |
|---|---|
| 17 messages nommés (clear-handler leak) | **44 messages nommés** (17 + 27 high-confidence) |
| 0 catalogue ML protocole | **1284 noms canoniques** disponibles + 80 .proto schemas |
| 0 candidate sets pour les ambigus | **744 messages avec 1-10 candidats** chacun (review possible) |
| 1323 messages "anonymes" | 1323 - 44 - 744 = **535 vrais inconnus** |

→ on passe de "1.3% du protocole nommé" à "**3.3% nommé + 56% disambig-able + 41% inconnus** (probablement nouveaux messages depuis Aug 2024)".

## Reproduction

```bash
# 1. Clone ModulX (déjà fait)
git clone https://github.com/ModulX/dofus-unity-proto.git \
  dofus-app/data/external/dofus-unity-proto/

# 2. Compile .proto → descriptor set
python -c "
from grpc_tools import protoc; import glob
protoc.main(['protoc',
  '--proto_path=dofus-app/data/external/dofus-unity-proto/game',
  '--descriptor_set_out=dofus-app/data/external/dofus-unity-proto/game.descriptorset.binpb',
  '--include_imports'] + sorted(glob.glob('dofus-app/data/external/dofus-unity-proto/game/*.proto')))"

# 3. Match
python dofus-app/scripts/match-proto-v2.py

# 4. Integrate dans rename table
python dofus-app/scripts/integrate-proto-mapping.py
```

## Sources

- [ModulX/dofus-unity-proto](https://github.com/ModulX/dofus-unity-proto)
- [LuaxY/dofus-unity-protocol-builder](https://github.com/LuaxY/dofus-unity-protocol-builder)
- [RuinedYourLife/dofus-deobfs](https://github.com/RuinedYourLife/dofus-deobfs)

---

## Voie A2 — Cross-ref Dofus 2 (legacy AS3) — session 7

Hypothèse : Dofus 3 dérive directement du protocole **Dofus 2** (Java/AS3), beaucoup plus largement open-sourcé. Le data model et l'ordre de sérialisation sont préservés dans 70% des cas → matching structurel doit donner du signal.

### Sources

| Repo | Format | Pushed | Volume parsé |
|---|---|---|---|
| [scalexm/DofusInvoker](https://github.com/scalexm/DofusInvoker) | AS3 décompilé (JPEXS) | 2019-05 | 7103 fichiers |
| [HadesFR/DofusInvoker](https://github.com/HadesFR/DofusInvoker) | idem, plus récent | 2020-12 | 7854 fichiers |

Cloné dans `dofus-app/data/external/dofus2-invoker-{scalexm,hades}/`. **HadesFR** (le plus récent) est utilisé par défaut.

### Pipeline

```
1. parse-dofus2-protocol.py
     scalexm + HadesFR  →  dofus2-protocol.json (1392 classes, 100% protocolId)
                            structure : { class, fullName, parent, protocolId, fields:[{name,type}] }

2. match-dofus2-against-current-v{0,1,2}.py
     dofus2-protocol.json + proto-schema-decompiled.json (D3, 1323 messages)
        →  build canonical signatures (wire-class tokens en ordre AS3 / Protobuf tag)
        →  bucket-match by signature
        →  output dofus2-match-v{N}.json
```

### Versions du matcher

| Version | Stratégie | Sig-perfect (single-bucket) | Vraies 1↔1 bidirectionnelles | No match |
|---|---|---|---|---|
| **v0** | Sig brute, sub-messages = `msg` opaque | 141 (10.7%) | ~5 | 51% |
| **v1** | Sub-sig depth-1 (`msg{i32,bool}` etc.) + parsing `RepeatedField<X>` corrigé | 23 (1.7%) | ~7 | 75% |
| **v2** | + collapse i32==i64, f32==f64 (AS3 has no int64) | 29 (2.2%) | **9** | 66% |

**Définition "vraies 1↔1"** : exactement 1 D2 candidate ET aucun autre D3 ne partage la même signature (bidirectionnel). C'est le seul critère structurel solide ; les "sig-perfect" non-bidirectionnelles produisent des faux positifs (ex : 5 D3 ont `string,i,i` → tous matchent vers le seul D2 ayant aussi `string,i,i`).

### Les 9 vraies matches v2

Persistées dans [`data/indexed/dofus2-true-perfect-matches.json`](../data/indexed/dofus2-true-perfect-matches.json).

| obf D3 | Dofus 2 candidate | proto2 ID | Statut |
|---|---|---|---|
| `hbz` | HelloConnectMessage | 7981 | à auditer |
| `hco` | HavenBagFurnituresRequestMessage | 2419 | à auditer |
| `iku` | AtlasPointInformationsMessage | 4680 | à auditer |
| `irp` | BreachBonusMessage | 5770 | à auditer (mécanique Brèches existe-t-elle ?) |
| `ito` | LockableStateUpdateHouseDoorMessage | 6331 | à auditer |
| `izt` | JobCrafterDirectoryListMessage | 1664 | plausible |
| `jxu` | GameDataPaddockObjectListAddMessage | 847 | à auditer (Paddock existe-t-il ?) |
| **`ksj`** | **GameFightPlacementPossiblePositionsMessage** | **8925** | **✓ confirmé runtime** (43 calls captés pile pendant le placement combat) |
| `ldp` | AllianceVersatileInfoListMessage | 1735 | à auditer |

### Faux positifs retirés

Le matcher v2 avait initialement proposé `igf = GameFightStartMessage` + `igm = Idol` (sub-message à 3 ints qui matche structurellement `Idol(id, xpBonusPercent, dropBonusPercent)`). **Retiré** parce que **les Idoles ont été supprimées en Dofus 3**. Leçon importante :

> **Le matching pur structurel ne suffit pas.** Une classe Dofus 2 référençant une mécanique supprimée en Dofus 3 reste un faux candidat permanent. Critère minimum pour valider une correspondance :
> 1. Sig structurelle bidirectionnelle 1↔1 (matcher v2)
> 2. La feature D2 existe encore en Dofus 3 (knowledge externe — au minimum demander au user)
> 3. Bonus : message observé runtime au moment cohérent (`gbe-probe` + corrélation gameplay)

À tenir à jour : un fichier `dofus3-features-blacklist.json` listant les classes D2 à exclure d'office. Pour l'instant : Idoles confirmées comme supprimées, le reste à compléter au fur et à mesure.

### Pourquoi le rendement reste limité

| Cause | Mitigation |
|---|---|
| Les sig très courtes (`i`, `bool`, `i,i`) collent à 100+ D2 candidats | Filtre length ≥ 3 ou ≥ 4 distinct types |
| Sub-messages D3↔D2 n'ont pas le même nom donc on collapse en `msg` opaque | **v3 graph-based** : utiliser les 770 ancres pour propager |
| Features Dofus 2 supprimées en Dofus 3 | **Blacklist features** (à construire) |
| AS3 has no native int64 | Déjà mitigated en v2 par collapse `i32==i64` |
| Ankama refactor des messages (split / merge) | Fuzzy match ±1 field |

### Prochaine étape — v3 graph-based

Plan détaillé pour la prochaine session :

1. **Charger les ancres** : 770 noms ModulX (`proto-name-mapping-v2.json`) + 17 clear-handlers + 9 sig-1↔1 v2.
2. **Pour chaque D3 inconnu** : énumérer ses sub-messages. Si un sub-msg est nommé (via les ancres), prendre son nom Protobuf canonique.
3. **Côté D2** : pour chaque candidat, vérifier que ses sub-messages référencés portent ce même nom canonique (ou un nom apparenté).
4. **Score** = % de sub-messages dont le nom matche + bonus si le parent matche aussi.
5. **Blacklist** appliqué avant de matcher : exclure les D2 dont la mécanique est supprimée.
6. **Output** : `dofus2-match-v3.json` avec `confidence ∈ [0, 1]`, sauvegarde des matches `confidence > 0.7`.

Effort estimé : 2-3 jours-dev.

### Outputs session 7 (matcher Dofus 2)

- [`dofus-app/data/external/dofus2-protocol.json`](../data/external/dofus2-protocol.json) — 1392 classes parsées
- [`dofus-app/data/indexed/dofus2-match-v0.json`](../data/indexed/dofus2-match-v0.json) — sig brute
- [`dofus-app/data/indexed/dofus2-match-v1.json`](../data/indexed/dofus2-match-v1.json) — sub-sig depth 1
- [`dofus-app/data/indexed/dofus2-match-v2.json`](../data/indexed/dofus2-match-v2.json) — collapse ints/floats
- [`dofus-app/data/indexed/dofus2-true-perfect-matches.json`](../data/indexed/dofus2-true-perfect-matches.json) — 9 vraies matches bidirectionnelles
- Scripts : `parse-dofus2-protocol.py`, `match-dofus2-against-current.py`, `match-dofus2-against-current-v1.py`, `match-dofus2-against-current-v2.py`
