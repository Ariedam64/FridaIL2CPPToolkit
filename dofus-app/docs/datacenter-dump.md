# Dofus 3.0 — Dump DataCenter (game data statique)

> Module Frida `src/rpc-agent/datacenter.ts` + driver `scripts/dump-datacenter.js`. Persiste tout le contenu de `Core.DataCenter.Metadata.*` en JSON dans `.toolkit-data/datacenter/`.

## Pourquoi c'est utile

`Ankama.Dofus.Core.DataCenter.dll` est une assembly **non obfusquée** (OPS Obfuscator ne touche pas les types tiers ni — apparemment — les data containers). 53 namespaces `Core.DataCenter.Metadata.*` couvrent tout le contenu statique du jeu : Items, Spells, Monsters, Quests, NPCs, Maps, Effects, Jobs, Achievements, etc. **Toutes les classes ont leurs noms originaux préservés**, avec field names et types intacts.

Conséquences :

1. **Mirror complet du contenu jeu** disponible offline en JSON.
2. **Ancre sémantique** pour la déobfuscation : quand un message Protobuf obfusqué a un field `i32` valant 1167735, on peut chercher cette valeur dans `ItemsDataRoot` → si match → c'est probablement un `itemId`. Pareil pour cellId (0..560), monsterId, spellId, areaId, etc.
3. **Catalog de noms canoniques** : chaque sous-namespace donne un domaine sémantique (Quest, Spell, etc.) qu'on peut utiliser pour étiqueter les obfClasses Core qui consomment ces données.

## Inventaire — 198 DataRoots

`listDataRoots` énumère statiquement toutes les classes dont le short name finit par `DataRoot`. Sur 198 trouvées, **56 ont un getter direct** `GetXxxById(int)` qui rend le dump immédiat.

Les autres 142 utilisent typiquement un field `List<XData>` ou `Dictionary<int, XData>` accessible via la stratégie 2 de `dumpDataRoot`. À ce stade seules les 17 plus utiles ont été dumpées en session 7.

## Dumps livrés (session 7)

| Root | Entries | Size | Description |
|---|---:|---:|---|
| **ItemsDataRoot** | **17 737** | 12.5 MB | catalogue armes / consommables / ressources / cosmétiques / familiers… |
| **SpellsDataRoot** | **13 640** | 6.9 MB | tous les sorts du jeu (avec scripts) |
| QuestObjectivesDataRoot | 15 546 | 0.4 MB | objectifs détaillés des quêtes |
| SpellScriptsDataRoot | 14 689 | 1.3 MB | scripts d'effets de sorts |
| MonstersDataRoot | 5 083 | 3.4 MB | tous les monstres avec stats |
| AchievementsDataRoot | 2 620 | 637 KB | quêtes/succès |
| QuestsDataRoot | 1 974 | 519 KB | quêtes principales |
| ItemSetsDataRoot | 918 | 122 KB | panoplies |
| EffectsDataRoot | 859 | 459 KB | effets génériques |
| SubAreasDataRoot | 550 | 341 KB | subareas du monde |
| InteractivesDataRoot | 428 | 20 KB | NPCs / zaaps / interactives |
| AlmanaxCalendarsDataRoot | 376 | 119 KB | calendriers almanax |
| SkillsDataRoot | 365 | 129 KB | skills de métiers |
| SkillNamesDataRoot | 332 | 15 KB | noms d'actions interactives |
| EmoticonsDataRoot | 320 | 108 KB | emoticons |
| HousesDataRoot | 261 | 30 KB | maisons |
| ItemTypesDataRoot | 152 | 31 KB | types d'items |
| CharacteristicsDataRoot | 122 | 22 KB | caractéristiques (vita/sagesse/...) |
| AreasDataRoot | 67 | 17 KB | zones macro |
| WorldMapsDataRoot | 35 | 8 KB | régions cartographiques |
| BreedsDataRoot | 19 | 11 KB | classes Dofus |
| MapsInformationDataRoot | 13 | 2 KB | infos macro maps |
| SuperAreasDataRoot | 9 | 1 KB | super-zones (continents) |
| ServersDataRoot | 1 | 0 KB | serveur courant |
| MapScrollActionsDataRoot | 1 | 0 KB | actions de scroll map |
| JobsDataRoot | 23 | 2 KB | métiers |

**Total** : ~57 000 entries, ~26 MB de JSON. Dumpé en ~60 secondes (lecture sérielle, jeu pas affecté).

## Roots non dumpés (à faire si besoin)

3 roots étaient sans instance vivante au moment du dump (au login screen) — il faut être en jeu avec un personnage pour qu'ils s'initialisent :

- `AlignmentSidesDataRoot`, `AlignmentRanksDataRoot`, `AlignmentTitlesDataRoot`
- `ActionFiltersDataRoot`

Et 142 roots sans getter direct dont les noms suggèrent des données plus rares :

- Notification, Alliance (rank suggestions, tag), Calendar Events, Guild Mission, House sub-data, Infinite Dreams, World Events / Bosses / Farming / Hunter / Rewards, etc.

À dumper à la demande via `dumpDataRoot("XxxDataRoot", 0, max)`.

## Format de sortie

Chaque fichier `.toolkit-data/datacenter/<RootName>.json` :

```jsonc
{
  "cls": "ItemsDataRoot",
  "fullName": "Core.DataCenter.ItemsDataRoot",
  "found": true,
  "sourceMethod": "GetItemById",      // ou "field:..." selon strategy
  "requestedMax": 30001,
  "extractedCount": 17737,
  "items": [
    { "id": 1, "fields": { "id": 1, "nameId": 685, "typeId": 1, "iconId": 8, ... } },
    ...
  ]
}
```

Pour les fields complexes (List, Dictionary), la valeur est un placeholder `"[N] (List`1)"` — le `dumpDataRoot` actuel ne descend qu'à **profondeur 1** pour rester rapide. Si on veut vraiment tout dumper récursivement, il faudra une variante.

## Usages dérivés (idées pour la suite)

1. **Cross-ref runtime ↔ DataCenter** : pour chaque message Protobuf observé runtime via `gbe-probe`, récupérer ses field values, chercher les ints dans les ranges de DataCenter ([1, 30000] = item, [1, 5000] = monster, [0, 560] = cellId, …) → label sémantique automatique.
2. **Localization** : `nameId` / `descriptionId` pointent vers des strings traduites. En dumpant aussi le LocalizedStringsDataRoot (si existe), on a tout le texte du jeu.
3. **Generation de référentiel pour outils tiers** : ce dump pourrait alimenter une wiki/db community.

## Outputs

- Module Frida : [`src/rpc-agent/datacenter.ts`](../../src/rpc-agent/datacenter.ts)
- Driver Node : [`scripts/dump-datacenter.js`](../../scripts/dump-datacenter.js)
- Dumps : [`.toolkit-data/datacenter/*.json`](../../.toolkit-data/datacenter/) (gitignore probable, à voir)
