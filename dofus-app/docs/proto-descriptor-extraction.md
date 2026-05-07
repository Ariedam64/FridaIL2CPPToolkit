# Dofus 3.0 — Tentative d'extraction des FileDescriptorProto

> Tentative de la piste #1 du document `dofus-deobfuscation-final.md` :
> récupérer les noms `.proto` originaux via les `static byte[]` FileDescriptor
> embarqués dans le binaire.

## TL;DR

**La piste originale (FileDescriptorProto byte[] embedded) est BLOQUÉE** :
Ankama a strippé le système de FileDescriptor au build. Les byte[] ne sont
nulle part — ni dans `Ankama.Dofus.Protocol.Game.dll` (Cpp2IL), ni dans
`GameAssembly.dll` (binaire natif IL2CPP).

**Mais le pivot a livré deux résultats actionnables** :

1. **99 noms de fichiers `.proto` extraits** depuis les paths source du package
   Unity `com.ankama.dofus.protocol.game@68c300a36ca8` → liste complète des
   modules du protocole Dofus 3.
2. **DLLs Cpp2IL enrichies** par le processor `attributeanalyzer/attributeinjector` :
   chaque type/method/field a maintenant `[Token]`, `[Address(RVA=…)]`,
   `[FieldOffset]`, `[GeneratedCode("protoc", null)]` → identifie sans ambiguïté
   les classes Protobuf-generated et donne les RVA exactes pour Frida.

---

## Méthodologie tentée

### Hypothèse de départ

Chaque classe Protobuf-générée par `protoc-csharp` embarque un
`static readonly byte[]` qui contient le binaire `FileDescriptorProto`. Le
runtime appelle `FileDescriptor.FromGeneratedCode(bytes, ...)` à la première
utilisation. Cpp2IL préserve normalement les `static byte[]` initializers en
copiant les RVA fields du PE.

Pattern recherché : tag 1 (name) du FileDescriptorProto = `0x0A <varint_len>
"<filename>.proto"`. On peut anchor sur `.proto`, backtracker pour valider, et
parser depuis le `0x0A`.

### Implémentation

[`scripts/extract-proto-descriptors-from-dll.py`](../scripts/extract-proto-descriptors-from-dll.py) :
- Scan `Ankama.Dofus.Protocol.Game.dll` pour le pattern
- Tente parse via `google.protobuf.descriptor_pb2.FileDescriptorProto`
- Output `dofus-app/data/proto-descriptors/` (FileDescriptorSet binaire + JSON résumé)

### Résultat : 0 descriptor trouvé

| DLL | Taille | `.proto` | `proto3` | `google.protobuf` | `FileDescriptor` |
|---|---|---|---|---|---|
| `Ankama.Dofus.Protocol.Game.dll` (`il_recovery`) | 2.6 MB | 99 (paths sources Unity) | 0 | 0 | 0 |
| `Ankama.Dofus.Protocol.Game.dll` (`cpp2il`) | 2.6 MB | 99 (idem) | 0 | 0 | 0 |
| `GameAssembly.dll` (binaire natif IL2CPP) | 112 MB | 0 | 0 | 0 | 0 |
| `global-metadata.dat` | 39 MB | 115 (paths sources) | 3 | 1 | 14 |

Les 99 occurrences de `.proto` dans le DLL Cpp2IL sont toutes des **paths source
Unity** (`\Library\PackageCache\com.ankama.dofus.protocol.game@…\Runtime\X.cs`),
pas des `FileDescriptorProto.name`. Aucun byte[] FileDescriptor n'est présent.

**Conclusion** : Ankama a buildé son protocole avec un compilateur Protobuf
custom (ou patché) qui omet les FileDescriptor binaires. Cohérent avec
l'observation runtime « `FromGeneratedCode` jamais appelé, `FileDescriptor`
toujours `null` » (cf. `protocol-runtime-observations.md`).

---

## Pivot 1 — Liste complète des 99 fichiers `.proto`

Découverte clé : les paths source Unity dans le metadata IL2CPP donnent les
noms exacts des fichiers source du package Protocol. Convention
`protoc-csharp` : `foo_bar.proto` → `FooBar.cs` → conversion triviale.

### Output

[`data/protocol/proto-source-files.json`](../data/protocol/proto-source-files.json)
— 99 entrées `{ cs, proto_inferred }` + version Unity du package
(`@68c300a36ca8`).

### Liste des 99 modules `.proto`

```
account, achievement, admin_console, alliance_conquest, alliance_information,
alliance_member, alliance_rank, alliance_recruitment, alteration, anomaly,
appearance, area, arena, atlas, bak, basic, bid_activity, bonus, calendar,
challenge, character, character_management, chat, choice, click,
client_verification, common, connection, constant, contact, context, cosmetic,
debt, debug, dialog, document, dungeon, element, emote, exchange, fight,
fight_preparation, game_action, gamemap, guild_application, guild_chest,
guild_contribution, guild_hall, guild_house, guild_information, guild_member,
guild_mission, guild_mission_configuration, guild_mission_reward,
guild_mission_view, guild_mission_weekly, guild_rank, guild_recruitment,
guild_shop, haapi, haven_bag, house, infinite_dream, interactive_element,
inventory, job, ladder, ladder_achievement, ladder_arena, ladder_dream,
ladder_experience, living_object, map, message, moderation, notification, npc,
party, ping, preset, prism, quest, report, ride, roleplay, script, security,
server, social, spell, suggestion, symbiont, tag_storage, taxcollector,
teleportation, tinsel, treasure_hunt, ui, world_event
```

### Implications

- **1323 messages Protobuf répartis sur 99 fichiers** = ~13 messages/fichier
  en moyenne (cohérent).
- Cette liste correspond **structurellement** aux protocoles Dofus 2 reverse-
  engineered par la communauté (mêmes catégories : Inventory, Fight, Spell,
  Roleplay, etc.).
- Permet **partition probabiliste** des 1443 classes obfusquées en 99 buckets
  par ordre alphabétique (OPS Obfuscator nomme dans l'ordre de déclaration).

---

## Pivot 2 — DLLs enrichies via Cpp2IL `attributeanalyzer`

### Processeur Cpp2IL utilisé

```bash
Cpp2IL.exe \
  --game-path "F:\Jeux\Dofus-dofus3" \
  --use-processor "attributeanalyzer,attributeinjector,deobfmap" \
  --output-as dll_il_recovery \
  --output-to "%TEMP%\cpp2il_attrs_out"
```

### Différences avec les DLLs précédentes

| Asset | Avant (`output_il_recovery`) | Après (`cpp2il_attrs_out`) |
|---|---|---|
| `Ankama.Dofus.Protocol.Game.dll` | 2.6 MB | **8.8 MB** (3.4×) |
| `Core.dll` | 5.7 MB | **18.7 MB** (3.3×) |

### Attributs injectés sur chaque type/méthode

Exemple sur `gui` (l'envelope universelle) :

```csharp
[Token(Token = "0x2000009")]
public sealed class gui : IMessage<gui>, IMessage, IEquatable<gui>, IDeepCloneable<gui>, IBufferMessage
{
    [Token(Token = "0x4000018")]
    [FieldOffset(Offset = "0x10")]
    private UnknownFieldSet dudn;

    [DebuggerNonUserCode]
    [GeneratedCode("protoc", null)]
    [Token(Token = "0x6000043")]
    [Address(RVA = "0x786B80", Offset = "0x785780", Length = "0xA")]
    public void blrv() { throw null; }
    ...
}
```

| Attribute | Contenu | Utilité |
|---|---|---|
| `[Token]` | metadata token IL2CPP | tracking stable cross-build |
| `[Address(RVA=...)]` | adresse exacte dans `GameAssembly.dll` | **hooking Frida précis** |
| `[FieldOffset(Offset=...)]` | offset dans la struct C++ | **scan mémoire / read direct** |
| `[GeneratedCode("protoc", null)]` | marqueur protoc | **distingue protoc vs hand-written** sans ambiguïté |
| `[DebuggerNonUserCode]` | hint Protobuf-generated property | confirme protoc |

### Valeur pour le toolkit

- **Hooks Frida précis** : pas besoin de chercher par nom obfusqué, on a la RVA
- **Filtre Protobuf** : la liste exacte des classes générées par protoc est
  dérivable en grep `[GeneratedCode("protoc"`
- **Field memory layout** : tous les offsets de struct connus pour scan/dump
  direct via `Memory.read*`

---

## Pourquoi Il2CppDumper ne marche pas

Le metadata Dofus 3 est en **version 39**, supporté par aucune release
publique d'Il2CppDumper (max v33 sur la dernière, v6.7.46). C'est probablement
une version Unity 6000.3 expérimentale (`Determined game's unity version to be
6000.3.3f1`) ou une variante customisée par Ankama.

Workarounds possibles :
- Forker Il2CppDumper et porter le support v39 (effort ~1 jour)
- Écrire un parser Python custom du format v39 (effort ~2 jours)
- Continuer à exploiter Cpp2IL (qui supporte v39 nativement) — préférable

---

## Voies de progression pour finaliser le mapping `obf_class → .proto`

Maintenant qu'on a la liste des 99 `.proto` files :

### Voie A — Bucketing alphabétique (rapide, probabiliste)
Si OPS Obfuscator nomme dans l'ordre de déclaration des fichiers source
(probable), partitionner les 1443 classes obfusquées sur les 99 buckets en
fonction de la taille relative de chaque `.proto`. Précision attendue : ~70%.

### Voie B — Match structurel contre Dofus 2 (fiable, automatisable)
La communauté maintient les `.proto` Dofus 2 complets. Pour chaque message
obfusqué, on a déjà `(field_count, [(tag, wire_type)])` (cf.
`proto-schema-decompiled.md`, 5462 fields enumerated). Match par signature
structurelle → mapping automatique pour la majorité.

### Voie C — Source file index dans le metadata (définitif)
Le format global-metadata.dat v39 contient pour chaque `MethodDefinition` un
`sourceFileIndex` (debug info IL2CPP). Parser correctement le format → mapping
exact `(type, method) → source_file → .proto`. Effort : moyen, valeur :
maximum (résultat ground-truth).

### Voie D — Forcer Dofus à initialiser les FileDescriptor au runtime
Trigger une vraie connexion réseau complète + login + premier paquet, puis
re-scanner via Frida. Mais l'observation runtime montre que **Dofus n'utilise
jamais le système FileDescriptor**, donc inutile.

---

## Outputs produits

- [`scripts/extract-proto-descriptors-from-dll.py`](../scripts/extract-proto-descriptors-from-dll.py) — scanner FileDescriptorProto (résultat : 0 trouvé, confirme le strip)
- [`scripts/extract-proto-source-names.py`](../scripts/extract-proto-source-names.py) — extracteur des 99 .proto names depuis le metadata
- [`data/protocol/proto-source-files.json`](../data/protocol/proto-source-files.json) — liste structurée des 99 fichiers
- `%TEMP%/cpp2il_attrs_out/*.dll` — DLLs Cpp2IL enrichies avec
  `[Token]`/`[Address]`/`[FieldOffset]`/`[GeneratedCode]`

## Recommandation pour la suite

1. **Voie B** (match contre Dofus 2 community .proto) — ~1h de scripting,
   gain : centaines de noms `.proto` automatiquement.
2. **Re-décompiler les DLLs enrichies** avec ilspycmd, indexer les classes par
   présence de `[GeneratedCode("protoc"`) — donne la liste **exacte** des
   1323+ classes Protobuf-generated (vs hand-written).
3. **Construire un mapping `obf_class → RVA`** depuis les nouvelles DLLs et
   l'injecter dans le toolkit Frida pour hook précis sans recherche par nom.
