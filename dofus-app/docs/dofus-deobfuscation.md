# Dofus 3.0 — Reverse de l'obfuscation

Investigation runtime via Frida/IL2CPP, process attaché : `Dofus.exe` (Unity / IL2CPP, Dofus 3.0).

> **👉 Pour la synthèse finale, voir [`dofus-deobfuscation-final.md`](./dofus-deobfuscation-final.md)**
>
> **Docs compagnons** :
> - [`dofus-deobfuscation-final.md`](./dofus-deobfuscation-final.md) — **synthèse finale** (toutes les sources, 11 vecteurs)
> - [`deobfuscation-map.md`](./deobfuscation-map.md) — table générée auto (~110 classes labellisées)
> - [`protocol-handlers.md`](./protocol-handlers.md) — topologie statique du protocole (1443 messages × 256 dispatchers)
> - [`protocol-runtime-observations.md`](./protocol-runtime-observations.md) — captures runtime live + envelope identifiée
> - [`proto-schema-decompiled.md`](./proto-schema-decompiled.md) — schéma Protobuf complet (1323 messages × 5462 fields)
> - [`decompiled-leaks.md`](./decompiled-leaks.md) — signatures de méthodes recovered (318 méthodes complètes)
> - [`dofus-deobfuscation-roadmap.md`](./dofus-deobfuscation-roadmap.md) — pistes faisables, état d'avancement
> - **[`proto-descriptor-extraction.md`](./proto-descriptor-extraction.md)** — *(s4)* tentative byte[] FileDescriptor + 99 .proto names extraits du metadata
> - **[`cpp2il-attribute-index.md`](./cpp2il-attribute-index.md)** — *(s5)* index complet 7600 types avec RVA + FieldOffset + Token via Cpp2IL `attributeanalyzer`
> - **[`voie-a-proto-name-matching.md`](./voie-a-proto-name-matching.md)** — *(s6)* matching structurel vs ModulX/dofus-unity-proto (27 confirmed + 744 candidates)
>
> **Reproduce** :
> - `python dofus-app/scripts/build-deobfuscation-map.py` (regénère la map principale)
> - `python dofus-app/scripts/build-protocol-handlers.py` (regénère la topologie protocole)
> - `python dofus-app/scripts/index-cpp2il-attrs.py` (regénère l'index RVA depuis DLLs Cpp2IL enrichies)
> - `python dofus-app/scripts/match-proto-v2.py` (regénère le matching .proto vs ModulX)
> - `python dofus-app/scripts/build-frida-rename-table.py` (consolide la rename table Frida)

## TL;DR

L'obfuscation Dofus est **hautement réversible** au runtime + offline. Sept conclusions clés (3 ajoutées en sessions 4-5-6) :

1. **L'obfuscateur est OPS Obfuscator** (commercial, attributes-driven). Il fait du **rename alphabétique simple** (`a`, `aa`, `ab`, ...) — pas d'unicode, pas de control-flow flattening agressif. Renomme classes + méthodes + fields. Le namespace `Ankama.Dofus.Protocol.Game` est **aussi renommé** (1443 messages → `gud, gue, ...`) mais le wire format Protobuf reste compatible.

2. **L'obfuscation laisse 8 vecteurs de leak** béants par lesquels on récupère la sémantique :
   - **Compiler-gen leak** — les `<MethodName>...` des state machines async/lambdas exposent les noms originaux (~514 méthodes leakées rien que dans Core).
   - **Survived names** — ~627 classes Pascal dans Core (root) + tous les `Core.X.Y.Z` namespacés survivent par `[DoNotRename]`.
   - **Inheritance leak** — les classes claires héritant d'une obfusquée donnent le domaine du parent (`fpz\`1` est la base de 196 UIs, `ghn` est la base de tous les `SpellZoneShape*Behavior`).
   - **Type leak** ☆ — le système de types est entièrement préservé. Toute classe obfusquée référence des types publics (`Com.Ankama.HaapiAnkama.Model.*`, `Google.Protobuf.IMessage`, `FMOD.Studio.EventInstance`, `DotNetty.Transport.Channels.IChannel`, `Core.DataCenter.Metadata.*`...) et ces références révèlent son rôle.
   - **Protocol topology leak** ☆☆ — chaque méthode `void Handle(SomeProtoMessage)` dans Core mappe `obf_message → obf_handler`. **3203 hits** trouvés au scan. Quand un handler a un nom Pascal-case (e.g. `FightEntitiesService`), le message qu'il prend est labellisé par cascade.
   - **Source paths metadata leak** ☆ *(s4)* — le `global-metadata.dat` IL2CPP expose les paths Unity Package source : **les 99 fichiers `.proto` du protocole sont identifiés par nom** (`account.proto, fight.proto, inventory.proto, ...`).
   - **Cpp2IL attribute injection** ☆☆☆ *(s5)* — les processors `attributeanalyzer/injector` reconstruisent `[Token] [Address(RVA)] [FieldOffset] [GeneratedCode("protoc"]` sur tous les types/methods/fields → **89 081 méthodes hookables par RVA directe** + **5228 fields avec offset C++** + **1442 classes Protobuf-generated identifiées sans ambiguïté**.
   - **AsyncStateMachine leak étendu** ☆☆ *(s5)* — l'attribut `[AsyncStateMachine(typeof(_003C<RealName>_003Ed__N))]` mappe **479 méthodes obfusquées à leur vrai nom** (e.g. `egq.ywp = ConsumeKardByCode @ RVA 0x16FD310`).

3. **L'identification par triangulation** fonctionne très bien. Sur les classes les plus actives, on tape une identité quasi-certaine en croisant les 5 vecteurs. Exemples :
   - `egq` → **HAAPI client (Ankama+Dofus)** : 17 méthodes leakées (`ConsumeKardByCode`, `GetAccountBids`, `GetAlmanaxEvent`...) + types `Com.Ankama.HaapiAnkama.Model.{Token,Almanax,KardKard,MoneyOgrine,BakBid,...}`
   - `emb` → **Shopi (boutique)** : `CreateCart`, `CreateOrder`, `GetShopCatalog` + types `Com.Ankama.Shopi.Model.{Cart,Order,Article,CatalogPage,AnkamaOgrinePayment}`
   - `els` → **AudioManager (FMOD)** : `DoLoadBank`, `InitializeAudioManager` + types `FMOD.Studio.EventInstance`, `Ankama.AudioManagement.AudioManagerLibrary`
   - `fzb` → **Network channel manager (DotNetty)** : `ConnectAsync`, `DisconnectAsync` + type `DotNetty.Transport.Channels.IChannel`
   - `gbe` → **Protobuf message dispatcher** : `SendNetworkMessageToClient` + type `Google.Protobuf.IMessage`
   - `eat` → **Cartography view** : `LoadCartographyImages` + sous-classes `CartographyBannerView`, `CartographyMapView`
   - `dxd` → **Inventory protocol service** (75 messages handled, refs `Core.UILogic.Inventory.Inventory`)
   - `ghn` → **SpellZoneShape behavior base** : 14 sous-classes `SpellZoneShape{Boomerang,Cone,Cross,...}Behavior`
   - `fpz\`1` → **UI base class générique** : 196 sous-classes (toutes les UIs nommées du jeu)

4. **Topologie protocole client mappée** : 1443 messages Protobuf, 810 ont au moins 1 handler (56% du protocole couvert), 256 dispatcher classes, 703 messages 1:1, **17 messages identifiés par leak via clear handlers** (`khe → FightEntities event`, `khn → Inventory event`, `izc → BuffsFight event`, etc.). Cluster cascade : 30 dispatcher classes obfusquées labellisées par les messages qu'elles handlent.

5. **Captures runtime live** : hooking `Google.Protobuf.CodedInputStream.ReadMessage` capte 178 parses sur 24 messages distincts en quelques minutes de jeu. Découverte clé : **`gui` est l'envelope universelle** (89 hits, structure `oneof` avec 3 sub-message types). Les noms `.proto` ne sont **pas récupérables au runtime** car Dofus a désactivé le système `FileDescriptor` (les 99 holders ont tous `value = null`, `FromGeneratedCode` n'est jamais appelé). ⚠️ Les sniffers intercept-tout sur le path réseau ont **crashé le PC** sous gameplay actif — à éviter en production. Préférer hooks atomiques par RVA précise (cf. session 5).

6. *(s4)* **Le binaire `byte[]` du FileDescriptorProto est strippé** par Ankama au build → récupération directe du nom .proto impossible. Mais le `global-metadata.dat` expose les paths source `\PackageCache\com.ankama.dofus.protocol.game@68c300a36ca8\Runtime\<Name>.cs` → **99 fichiers `.proto` identifiés par nom** (account, achievement, fight, inventory, spell, roleplay, ui, world_event, ...).

7. *(s5-6)* **Pipeline offline complet** Cpp2IL → ilspycmd → index Python → rename table : **402 classes labellisées + 479 méthodes hookables par RVA + 44 messages `.proto` nommés** (haute confiance) + **744 messages avec liste de candidats `.proto`** (à désambiguer). Les hooks Frida sont maintenant **atomiques** (pas d'intercept-tout) → fini les crashs.

## L'obfuscateur

Détecté via l'assembly `OPS.Obfuscator` (12 classes), namespace `OPS.Obfuscator.Attribute` :

| Attribute | Effet |
|---|---|
| `DoNotRenameAttribute` | nom original conservé |
| `DoNotObfuscateClassAttribute` | classe entière exclue |
| `DoNotObfuscateMethodBodyAttribute` | corps de méthode lisible |
| `DoNotUseClassForFakeCodeAttribute` | exclut de l'**injection de fake code** |
| `ObfuscateAnywayAttribute` | force l'obfuscation |
| `NotObfuscatedCauseAttribute` | doc interne du *pourquoi* |

**Ce que fait l'obfuscation** :
- Rename des classes (4431 sur 6694 dans `Core` root → `a, b, c, ..., baa, bab, ...`)
- Rename des méthodes (en lettres aléatoires aussi : `bhzn`, `tjt`, `ywi`...)
- Rename des fields (`<dghv>k__BackingField`, `dgaj`, `dgak`...)
- **Pas** de string encryption visible — les strings restent en clair en mémoire
- **Pas** d'unicode ni de control-chars

**Ce que l'obfuscation NE fait PAS / NE PEUT PAS faire** :
- Renommer le système de types (impossible : le runtime IL2CPP a besoin des types pour fonctionner)
- Renommer les classes héritées de Unity / .NET (Unity les invoque par nom)
- Renommer les types publics référencés (Protobuf, DotNetty, FMOD, BouncyCastle)
- Renommer les state machines compilateur (`<X>d__N`, `<X>b__N>d`)
- Renommer les classes marquées `[DoNotRename]` (toutes les UIs publiques, les services nommés, les enums)

## Cartographie générale des assemblies

130+ assemblies, distribution clear/obfusqué :

```
Core                                  8923 classes   ≈ 50% obfusqué (mostly root NS)
Ankama.Dofus.Protocol.Game            4892 classes   100% clear (Protobuf)
Ankama.Dofus.Protocol.Connection       115 classes   100% clear
Ankama.Dofus.Core.DataCenter           566 classes   100% clear
Ankama.Dofus.Core.World                 51 classes   100% clear
Ankama.Dofus.Core.Characters            24 classes   100% clear
Com.Ankama.HaapiAnkama                1328 classes   100% clear (HTTP API client)
Com.Ankama.HaapiDofus                  137 classes   100% clear
Com.Ankama.Shopi                       340 classes   100% clear (boutique)
Ankama.AudioManagement                 454 classes   100% clear
Ankama.Animator2D                      148 classes   100% clear
ZaapClient                             178 classes   100% clear (launcher API)
XLuaAssembly                           120 classes   100% clear (Lua scripting)
```

Stack tech identifiée :
- **Réseau** : `Google.Protobuf` + `DotNetty.{Common, Transport, Codecs, Buffers, Handlers}` (Netty C# port)
- **Crypto** : `BouncyCastle.Crypto` (TLS/AES/RSA)
- **HTTP** : `RestSharp` + `Polly` (retry policies)
- **Compression** : `K4os.Compression.LZ4`
- **Audio** : FMOD Studio
- **Crash reporting** : Sentry
- **Lua embed** : XLua (scripting moddable côté client — possiblement très intéressant)
- **Tween** : DOTween
- **UI** : UnityEngine.UIElements (UI Toolkit moderne)
- **Async** : Cysharp UniTask

## Anatomie de l'obfuscation dans `Core`

`Core` contient 8923 classes ; **6694 sont dans le namespace racine** (sans `Core.X.Y`). C'est là que se concentre l'obfuscation.

### Pattern de renaming OPS

Sur 6694 noms du root namespace :

| Pattern | Count | Statut |
|---|---|---|
| `ba`, `baa`, `bab`, ... `xyz` (1-3 chars lowercase) | **4431** | **Obfusquées** |
| `<<Method>b__N>d`, `<Method>d__N` (compiler-gen) | 1569 | **Leak** : nom original entre `<...>` |
| Pascal case (Achievement, Cell, Fight...) | 627 | Conservées (`DoNotRename`) |
| `ClassName\`N` (génériques) | 51 | Mix |
| `__StaticArrayInitTypeSize=N` | 16 | Data init (compiler-gen) |

### Ordre alphabétique exploitable

OPS Obfuscator semble nommer dans l'ordre de déclaration des classes dans la DLL, donc des classes voisines dans l'alphabet (`emb` / `eml` / `emr`) sont probablement dans le **même fichier source ou même domaine logique**. Donné que `els` = AudioManager, `eml` ou `emr` ont une chance non-négligeable d'être audio aussi (à confirmer).

## Plan de déobfuscation continu

État actuel : ~110 classes obfusquées identifiées avec un label de domaine raisonnable. Pour étendre, voir [`dofus-deobfuscation-roadmap.md`](./dofus-deobfuscation-roadmap.md) pour la liste complète des pistes.

Top priorités :

1. **Récupérer les vrais noms `.proto`** (résout #1 entièrement) :
   - Hook `MessageParser<T>.ParseFrom` au runtime quand un paquet réel arrive — la pile contient le `MessageDescriptor` peuplé
   - OU déclencher une init complète (login + premier paquet) puis re-scanner les FileDescriptors
   - OU solution offline : `Il2CppDumper` sur les fichiers du jeu + dnSpy
2. **Dumper l'instance singleton de `gbe`** via SCANNER + lire les 4 dictionaries `Type→Handler` → mapping exact runtime
3. **Lire les CustomAttributes IL2CPP** via `Memory.read*` direct sur `il2cpp_class_get_custom_attribute_class` → distingue vraies classes / fake classes (`DoNotUseClassForFakeCode`)
4. **Mining XLua** — XLuaAssembly expose des classes au scripting Lua avec leurs vrais noms (Lua = string-based reflection)
5. **Greffer un rename layer** dans le toolkit pour afficher les noms déobfusqués partout

## Outils & artifacts

**RPC custom** (dans `src/rpc-agent/explorer.ts`) :
- `dumpAssemblyShape(asm, limit)` — itère toutes les classes d'un assembly (nom, namespace, declaring, methods, fields, parent) ✓
- `dumpCompilerGenLeaks(asmRegex, limit)` — extrait les leaks `<MethodName>` + déclarant (bug : retourne 1 entrée — workaround Python)
- `buildProtoHandlerMap(msgAsm, handlerAsmRegex)` — scan toutes les méthodes prenant un Protobuf message en param ✓ (le grand gagnant pour la topologie protocole)
- `dumpProtobufFileDescriptors`, `harvestProtoSchema`, `dumpStaticByteArrays` — tentatives pour récupérer les noms `.proto` (échec : FileDescriptors lazy-init non triggeable)

**Scripts Python** (dans `dofus-app/scripts/`) :
- `build-deobfuscation-map.py` — agrège shape + dumps + protocole en [`deobfuscation-map.md`](./deobfuscation-map.md)
- `build-protocol-handlers.py` — génère [`protocol-handlers.md`](./protocol-handlers.md) depuis le scan handler

**Données brutes** (dans `%TEMP%/`) :
- `shape_<asm>.json` — shape par assembly
- `dumps/<obf>.txt` — 80 dumps de classes obfusquées (méthodes + fields)
- `proto_handlers.json` — scan complet handlers (1443 messages, 3203 hits)

**API** : `POST http://localhost:3000/api/call` `{method, args}` → proxy Frida RPC

## Limites connues / pistes d'amélioration

- **Les FileDescriptors Protobuf sont lazy-init** au runtime et non accessibles via Frida classique. Workaround : hook ParseFrom au runtime ou Il2CppDumper offline.
- **Le bridge ne lit pas les CustomAttributes** → on devine `[DoNotRename]` par pattern syntaxique. À implémenter via `Il2Cpp.Api` raw functions.
- **Le rename des méthodes empêche `findByMethod` direct** sur les noms — ne marche que sur Unity callbacks (`OnEnable`, `Start`) ou overrides de classes claires.
- **Une classe obfusquée isolée** (sans compiler-gen + sans hériter de classe claire + sans field/return type public + sans handler protocole) est invisible. Rare en pratique (la plupart des services touchent au moins une lib externe ou le protocole).
- **Fake classes injectées par OPS** non filtrées — on traite toutes les classes obfusquées sans distinguer vrais services / leurres. À ajouter via lecture de `[DoNotUseClassForFakeCode]`.
