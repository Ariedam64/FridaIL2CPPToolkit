# Sprint multi-path — pousser la déobfusc Dofus 3 au-delà des 50%

> Conception d'un sprint de 1-3 jours qui combine 4-5 nouvelles sources
> de signal (jamais tentées chez nous) avec un pipeline de merge unifié
> dans `frida-rename-table.json`. Cible : passer de ~50% à 85-95% du
> plafond pratique de déobfusc (où les noms originaux strippés du
> metadata IL2CPP sont irréversibles).

## TL;DR

| Jour | Outils | Cible | Risque |
|---|---|---|---|
| **J1** | AssetRipper bundles + DBI/DDC merge + protodec --il2cpp | +100 à +400 classes Core nommées | Bas (déterministe) |
| **J2** | Hook FileDescriptor par signature offline (Cpp2IL XRefs) → Frida hook ciblé par RVA | +50 à +1300 messages `.proto` nommés | Moyen (variance haute, **timebox 1 jour**) |
| **J3** | String-refs sweep `GameAssembly.dll` + merge final + regen docs | +50 à +200 classes Core (filet de sécurité) | Bas |

**Hypothèse forte** validée par la recherche : OPS Obfuscator strippe les
byte[] static FileDescriptor mais préserve les méthodes init de chaque
classe Protobuf-generated (qui reçoivent les bytes en RAM **avant** le
strip apparent). En les hookant par signature plutôt que par nom, on
peut récupérer les descriptors complets au boot du jeu.

## Contexte projet

État actuel ([sessions 1-7 résumées dans `dofus-deobfuscation-final.md`](../../dofus-deobfuscation-final.md)) :
- ~110/4431 classes Core labellisées
- 44/1323 messages `.proto` nommés haute confiance + 744 candidate sets
- 89 081 méthodes avec RVA (Cpp2IL `attributeanalyzer/injector`)
- 5228 fields avec FieldOffset
- 5 modules Frida runtime + 17 DataCenter dumps + cross-ref Dofus 2

**Pistes invalidées** : XLua (vide), Sentry breadcrumbs (errors-only),
match D3↔D2 pur structurel (plafonne à 9 vraies matches), `FromGeneratedCode`
hook (jamais appelé — méthode probablement renommée par OPS).

## Architecture

```
[AssetRipper sur bundles]      → data/external/assetripper-monobehaviours.json
[DBI/DDC interop assemblies]   → data/external/dbi-name-table.json
[protodec --il2cpp dump]       → data/external/protodec-schema/*.proto
[Hook FileDescriptor runtime]  → data/runtime/protobuf-descriptors-captured.json
[String-refs natif]            → data/indexed/string-refs-classlinks.json
                                              │
                                              ▼
              [merge-rename-table.py (orchestrateur unifié)]
                                              │
                                              ▼
              data/indexed/frida-rename-table.json (étendu)
                                              │
                                              ▼
              dofus-app/docs/deobfuscation-map.md (regen)
```

**Format unifié pour chaque source** :
```json
{
  "obf_name": "egq",
  "original_name": "HaapiClient",
  "namespace": "Ankama.Haapi",
  "confidence": "high_unique" | "high_runtime" | "medium_xref" | "low_struct_match",
  "evidence_source": "assetripper" | "dbi" | "protodec" | "filedescriptor_hook" | "stringrefs" | ...,
  "evidence_detail": "<lien ou ID vers la source>"
}
```

**Règles de merge** :
- Conflits non-écrasants : si 2 sources nomment différemment le même
  `obf_name`, agréger en `name_candidates: [...]` au lieu d'arbitrer
  silencieusement, et logger dans `merge-conflicts.md`
- Concordance multi-source bump le confidence : 2 sources `medium_xref`
  qui concordent → `high_unique`
- Métadonnées RVA + FieldOffset existantes préservées

**Garde-fous opérationnels** (issus des leçons sessions précédentes) :
- Pas de `gc.choose` en boucle (freeze garanti)
- Hook FileDescriptor par RVA précise depuis l'index Cpp2IL, **pas
  d'intercept-tout** (a crashé le PC en session 2)
- Tous les outputs JSON, pas de pickle/binary custom
- Chaque jour produit un commit utilisable, sprint interruptible

## Détail des étapes

### Jour 1 — Quick wins déterministes

#### 1.1 AssetRipper sur bundles Unity

**Pourquoi ça marche** : Unity sérialise les MonoBehaviour avec leur nom
de script en clair (`m_Script.m_ClassName + m_Namespace`), indépendamment
de l'obfusc IL2CPP. AssetRipper supporte Unity 6000.5.X.

**Pipeline** :
1. AssetRipper sur `Dofus_Data/StreamingAssets/aa/`, `Resources.assets`,
   `sharedassets*.assets`
2. Mode Export, Scripts off (pas besoin du recovery IL2CPP), Resources
   YAML on
3. Parser YAML → extract `(MonoScript.m_ClassName, m_Namespace,
   m_AssemblyName)` pour chaque MonoBehaviour référencé
4. Cross-ref avec l'index Cpp2IL pour mapper `original_name → obf_name`
   (via Token IL2CPP préservé)

**Output** : `data/external/assetripper-monobehaviours.json`

**Risques** :
- Si Dofus utilise principalement Addressables avec scripts non
  sérialisés en YAML → output réduit. Mitigation J1 : critère go/no-go
  fin de journée.

**Effort** : 3-4h.

#### 1.2 DBI/DDC merge

**Pourquoi ça marche** : `Dofus-Batteries-Included/DDC` (v0.11.30,
2025-06-17) est la communauté Dofus 3 active la plus à jour. Leurs
interop assemblies versionnées par build-guid contiennent des mappings
`obf → friendly` qu'on peut extraire.

**Pipeline** :
1. Cloner `Dofus-Batteries-Included/{DDC,DBI.Plugins,DBI.Api}` dans
   `data/external/dbi/`
2. Récupérer les NuGet packages d'interop, identifier les fichiers
   contenant les mappings (CSV/JSON dans le repo, ou métadonnées via
   ilspycmd des DLL générées)
3. Lire `Dofus_Data/boot.config` pour récupérer notre build-guid
4. Filtrer DBI par build-guid : match → `confidence = high_unique` ;
   mismatch → `confidence = medium_xref` (catalogue de noms canoniques)

**Output** : `data/external/dbi-name-table.json`

**Risques** :
- Build-guid mismatch probable (DBI peut être en avance ou en retard
  d'une version vs notre snapshot). Plan B activé automatiquement
  (catalogue plutôt que mapping direct).

**Effort** : 4-6h.

#### 1.3 protodec --il2cpp

**Pipeline** :
1. `protodec --il2cpp Dofus_Data/Managed-cpp2il/Protocol.Game.dll out/proto-rebuilt/`
2. Diff vs `proto-schema-decompiled.json` : confirme/invalide les 27
   high-conf de Voie A
3. Cherche les noms de messages éventuellement préservés que ni nous ni
   ModulX n'avons capturés

**Output** : `data/external/protodec-schema/*.proto` +
`data/external/protodec-cross-check.json`

**Effort** : 1-2h.

#### 1.4 Merge fin J1

`scripts/merge-rename-table.py` consomme les 3 outputs J1. Regen
`deobfuscation-map.md`. Commit.

**Critère go/no-go fin J1** : si <50 nouvelles classes nommées avec
`confidence ≥ medium`, l'hypothèse "Dofus utilise des MonoBehaviour
sérialisés en YAML" est fausse → ajuster J3 pour passer plus de temps
sur stringrefs (au lieu de matin seulement).

### Jour 2 — Hook FileDescriptor par signature (timebox 1 jour)

**Hypothèse de travail** : OPS strippe les byte[] static finaux mais les
méthodes init Protobuf-generated reçoivent les bytes en RAM avant le
strip. Le hook session 2 sur `FileDescriptor.FromGeneratedCode` était
inactif parce qu'OPS a renommé/inliné cette méthode. Approche nouvelle :
**localiser les call sites par XRefs offline, hooker par RVA précise**.

#### 2.1 Localisation offline (matin, ~3h, no risk)

**Stratégie A — XRefs sur `MessageDescriptor.BuildAllFrom`** :
1. Dans l'index Cpp2IL, chercher toutes les méthodes dont la signature
   contient `byte[]` en premier param
2. Filtrer celles qui appellent `MessageDescriptor.BuildAllFrom` ou
   `FileDescriptorProto.Parser.ParseFrom`, ou dont le body référence
   `Google.Protobuf.Reflection.*`
3. Cross-ref avec `[GeneratedCode("protoc")]` : les classes Protobuf-
   generated ont toutes une méthode `static .cctor` qui appelle l'init
   descriptor. Repérer le call site dans la décompilation ilspycmd

**Stratégie B — pattern matching natif x64** (fallback si A retourne <50
candidats) :
- La méthode init de FileDescriptor a une signature x64 reconnaissable
  (alloc byte[], copy embedded data, call BuildAllFrom). Scan
  `GameAssembly.dll` pour le pattern → liste de RVA candidats.

**Output** : `data/runtime/filedescriptor-init-candidates.json` =
`[{rva, class_obf_name, method_obf_name, evidence}]`. Cible : 80-99
candidats (1 par .proto file de notre `proto-source-files.json`).

#### 2.2 Hook ciblé runtime (après-midi, ~4h, faible risk)

Module Frida `src/rpc-agent/proto-descriptor-capture.ts` :
- Pour chaque RVA candidat, install hook ATOMIQUE par RVA (pas
  d'intercept-tout)
- onEnter : lire arg0 = `byte[]*` IL2CPP → dump tableau brut + class
  name caller → buffer en mémoire
- onLeave : rien (no-op pour minimiser overhead)
- Throttle : max 200 hits par session
- Une seule fonction RPC `getCapturedDescriptors()` qui dump le buffer

**Driver** : `scripts/capture-proto-descriptors.js` — install hooks →
ramène le client Dofus → attendre l'init des descriptors (login screen +
premier chargement de map) → dump → désinstall.

**Parser** : `scripts/parse-captured-descriptors.py` — parse les byte[]
comme `FileDescriptorProto` (Google.Protobuf bibliothèque standard,
format wire stable).

#### 2.3 Critère go/no-go fin J2

| Captures | Action |
|---|---|
| ≥ 10 fichiers `.proto` complets | **Succès** : parse + merge le soir, J3 normal |
| 1-9 fichiers | **Succès partiel** : on garde, J3 string-refs en complément |
| 0 fichiers | **Échec** : OPS a réécrit le pipeline Protobuf custom. Désinstall, J3 stringrefs sur **journée entière** |

**Pas d'acharnement timebox-busting**. Décision binaire 18h fin J2.

### Jour 3 — String-refs + merge final + livrables

#### 3.1 String-refs sweep (matin, ~3-4h)

**Méthodologie VRChat phase 2 adaptée** :
1. Extraire toutes les string ASCII/UTF-16 ≥ 4 chars du segment `.rdata`
   de `GameAssembly.dll`
2. Filtrer par patterns intéressants :
   - Logger names : `"Some.Class.Name"`, `"Loading <X>"`, `"Failed to <Y>"`
   - Exception messages : `"<X> not found"`, `"Cannot <verb> <noun>"`
   - Asset paths : `"Assets/Scripts/<...>/<X>.cs"`,
     `"PackageCache/com.ankama.*"`
   - Telemetry/Sentry tags : `"category=<X>"`, `"event=<Y>"`
3. Pour chaque string trouvée, scanner les XRefs (instructions
   `lea rax, [string]`) → liste des fonctions qui la référencent
4. Cross-ref avec l'index Cpp2IL : `(class_obf_name, method_obf_name)` →
   label candidate

**Heuristiques de confidence** :
- String type "nom de classe propre" + 1 classe la référence →
  `high_unique`
- String exception référencée par 2-5 classes → `medium_xref`
- String référencée par 50+ classes → ignorée (logger générique)

**Output** : `data/indexed/string-refs-classlinks.json`

#### 3.2 Merge final (après-midi, ~2h)

`merge-rename-table.py v2` consomme tout :
- `assetripper-monobehaviours.json` (J1)
- `dbi-name-table.json` (J1)
- `protodec-cross-check.json` (J1)
- `protobuf-descriptors-captured.json` (J2, peut être vide)
- `string-refs-classlinks.json` (J3)
- Sources existantes : `deobfuscation-map.json`, `frida-rename-table.json`,
  `proto-name-mapping-v2.json`

**Règles** : voir Architecture (conflits non-écrasants, agrégation
multi-source, préservation RVA/FieldOffset).

#### 3.3 Regen + commit

- `deobfuscation-map.md` regen
- `dofus-deobfuscation-final.md` mis à jour (section "Session 8 —
  Multi-path sprint")
- Commits propres : 1 par jour minimum (J1, J2, J3) pour bisect futur

## Livrables sprint

| Catégorie | Fichier |
|---|---|
| Scripts Python | `merge-rename-table.py`, `parse-assetripper-monobehaviours.py`, `parse-dbi-tables.py`, `parse-captured-descriptors.py`, `extract-stringrefs-classlinks.py`, `find-filedescriptor-init-rvas.py` |
| Frida | `src/rpc-agent/proto-descriptor-capture.ts` |
| Drivers Node | `scripts/capture-proto-descriptors.js` |
| Data nouvelle | 5 outputs JSON (architecture) + `frida-rename-table.json` v2 + `merge-conflicts.md` |
| Docs | `session-8-multipath.md` ou update `dofus-deobfuscation-final.md` |

## Métriques de succès

| Métrique | Avant sprint | Cible mini | Cible idéale |
|---|---|---|---|
| Classes Core nommées | ~110 | 210 (+100) | 510 (+400) |
| Messages `.proto` haute conf | 44 | 94 (+50) | 1044 (+1000) |
| % du plafond pratique atteint | 75% | 85% | 95% |

**Critères d'arrêt anticipé** :
- Si J1 sort 0 résultats utilisables → revoir l'architecture, replanifier
- Si J2 hook FileDescriptor donne 0 captures **et** J1 a déjà sorti
  >300 nouvelles classes → on arrête là, le sprint a déjà rempli son
  objectif côté Core, J3 devient cherry on top

## Hors scope

- **Rename layer Frida live** : explicitement reporté (cf. mémoire claude
  `feedback_rename_last`). Le `frida-rename-table.json` est consommé
  offline pour les docs ; pas de hook `Il2Cpp.Class.name` dans ce sprint.
- **LLM bottom-up rename** (GenNm/Claude Code à la mattwebb 2025-10) :
  reporté à un sprint suivant. Cohérent comme follow-up une fois qu'on a
  un corpus de truth ≥ 500 classes.
- **MITM TLS du trafic Dofus** : possible mais redondant si
  J2 FileDescriptor hook réussit, et plus risqué (TOS).
- **BinDiff entre builds Dofus 3 successifs** : utile pour propager les
  noms entre versions futures, pas pour ce sprint.

## Sources

- [Dofus-Batteries-Included/DDC](https://github.com/Dofus-Batteries-Included/DDC)
- [Dofus-Batteries-Included/DBI.Plugins](https://github.com/Dofus-Batteries-Included/DBI.Plugins)
- [AssetRipper releases](https://github.com/AssetRipper/AssetRipper/releases)
- [Xpl0itR/protodec](https://github.com/Xpl0itR/protodec)
- [vrchat-il2cpp-re — méthodologie 8 phases](https://github.com/dwgx/vrchat-il2cpp-re)
- [arkadiyt — protobuf reversing 2024](https://arkadiyt.com/2024/03/03/reverse-engineering-protobuf-definitiions-from-compiled-binaries/)
- [frida-il2cpp-bridge — Reversing a protobuf game discussion](https://github.com/vfsfitvnm/frida-il2cpp-bridge/discussions/406)

## Reproduction (commandes)

```bash
# J1 — AssetRipper
AssetRipper.exe Dofus_Data/StreamingAssets Dofus_Data/Resources.assets \
  --export out/assetripper-export --scripts off --resources yaml
python dofus-app/scripts/parse-assetripper-monobehaviours.py \
  --input out/assetripper-export \
  --output dofus-app/data/external/assetripper-monobehaviours.json

# J1 — DBI
git clone https://github.com/Dofus-Batteries-Included/DDC \
  dofus-app/data/external/dbi/DDC
git clone https://github.com/Dofus-Batteries-Included/DBI.Plugins \
  dofus-app/data/external/dbi/DBI.Plugins
python dofus-app/scripts/parse-dbi-tables.py \
  --dbi-root dofus-app/data/external/dbi \
  --our-build-guid $(awk -F= '/build-guid/{print $2}' Dofus_Data/boot.config) \
  --output dofus-app/data/external/dbi-name-table.json

# J1 — protodec
dotnet tool run protodec --il2cpp \
  Dofus_Data/Managed-cpp2il/Protocol.Game.dll \
  dofus-app/data/external/protodec-schema/

# J2 — Localisation FileDescriptor init
python dofus-app/scripts/find-filedescriptor-init-rvas.py \
  --index dofus-app/data/indexed/protocol-game.classes.json \
  --output dofus-app/data/runtime/filedescriptor-init-candidates.json

# J2 — Hook runtime (Frida attached)
PORT=3001 node dofus-app/scripts/capture-proto-descriptors.js \
  --candidates dofus-app/data/runtime/filedescriptor-init-candidates.json \
  --output dofus-app/data/runtime/protobuf-descriptors-captured.json

# J3 — String refs
python dofus-app/scripts/extract-stringrefs-classlinks.py \
  --binary "C:\Path\To\GameAssembly.dll" \
  --index dofus-app/data/indexed/core.classes.json \
  --output dofus-app/data/indexed/string-refs-classlinks.json

# J3 — Merge final
python dofus-app/scripts/merge-rename-table.py
```
