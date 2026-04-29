# Sprint multi-path deobfusc - Doc de revue (post Tasks 13 + 14)

> Liste consolidee des **458 entrees de deobfusc** emises par le sprint pour audit manuel.
> Produit le 2026-04-29 apres Tasks 13 (clear-DLL xref) + 14 (inlined strings).

## Synthese

| Categorie | Count |
|---|---|
| high_unique sur **obf 1-4 letter** (vraies deobfusc) | 32 |
| high_unique sur clear classes (DBI confirms - deja claires) | 38 |
| medium_xref sur obf | 280 |
| low_struct_match sur obf | 108 |

Objectif de la revue : passer **les 32 high_unique** d'abord (a valider/corriger), puis echantillonner les medium_xref. Les low_struct_match sont du bruit attendu.

---

## 1. high_unique sur obf (32) - vraies deobfusc a confirmer

| obf | label infere | sources | parents (top 3) |
|---|---|---|---|
| `dsb` | **RenderService** | inlined_strings | dqv |
| `egq` | **HaapiService** | inlined_strings | eqa, fqr |
| `ejr` | **RenderService** | inlined_strings | ewf, fqq, fqr |
| `els` | **AudioService** | inlined_strings | ent, fqq, fqr |
| `ent` | **AudioService** | clear_dll_xref + inlined_strings | (none) |
| `eod` | **CachedDataService** | clear_dll_xref | (none) |
| `epd` | **DisplayableService** | clear_dll_xref | (none) |
| `erb` | **MapDisplayService** | clear_dll_xref | (none) |
| `erw` | **RoleplayEntitiesService** | clear_dll_xref | (none) |
| `ery` | **RoleplayIntroductionService** | clear_dll_xref | (none) |
| `ett` | **DofusContextualMenuDependenciesService** | clear_dll_xref | (none) |
| `etu` | **DofusContextualMenuService** | clear_dll_xref | (none) |
| `etv` | **DragAndDropService** | clear_dll_xref | (none) |
| `eue` | **HyperlinkService** | clear_dll_xref | (none) |
| `evm` | **FightEntitiesService** | clear_dll_xref | enc, fqs, fqr |
| `evq` | **FightPreviewMovedEntitiesService** | clear_dll_xref | (none) |
| `evs` | **FightPreviewSummonedEntitiesService** | clear_dll_xref | (none) |
| `eyt` | **MarkedCellsService** | clear_dll_xref | fqr |
| `fpd` | **HavenbagFurnitureSprite** | clear_dll_xref | (none) |
| `fqj` | **BasePopup** | clear_dll_xref | (none) |
| `fqt` | **MapDisplayService** | clear_dll_xref | fqu |
| `fqx` | **FightService** | inlined_strings | (none) |
| `frc` | **SerialSequencer** | clear_dll_xref | (none) |
| `fre` | **SerialSequencer** | clear_dll_xref | (none) |
| `ftd` | **DataStoreJsonService** | clear_dll_xref | (none) |
| `ftf` | **OptionJson** | clear_dll_xref | (none) |
| `gav` | **SetAnimationAction** | clear_dll_xref | (none) |
| `ghb` | **FightSequence** | clear_dll_xref | (none) |
| `lf` | **GroupFeatureCriterion** | clear_dll_xref | lg, IDataCenter |
| `lg` | **Criterion** | clear_dll_xref | (none) |
| `rb` | **HavenbagFurnitureSprite** | clear_dll_xref | (none) |
| `re` | **HavenbagFurnitureSprite** | clear_dll_xref | (none) |

### Notes pour la revue

- `els -> AudioService` confirme : connu de session 1 (FMOD). Confirme par inlined strings.
- `egq -> HaapiService` confirme : connu de session 1 (HAAPI). Confirme par inlined strings.
- `ent -> AudioService` (deux sources concordent) : possible nouveau service audio (ent/els pourraient etre interface vs impl).
- `ejr / dsb -> RenderService` : entity rendering (a differencier).
- `fqx -> FightService`, `bmm -> FightService` : peut-etre 2 services differents.
- `fpd / rb / re -> HavenbagFurnitureSprite` : la meme classe ou 3 variantes (heritage probable).
- `lf -> GroupFeatureCriterion`, `lg -> Criterion` : confirme la famille `lh = AccountRightsCriterionBase`.
- `cou/cov/cow/dop/dmr` (medium_xref ci-dessous) ont des labels qui ressemblent a d'autres obf names = faux positifs ou l'heuristique a pris le field name verbatim alors qu'il etait lui-meme obf.

## 2. medium_xref sur obf (280) - echantillon des plus suspects

| obf | label infere | sources |
|---|---|---|
| `cou` | Dajz (suspect - looks obf) | clear_dll_xref |
| `cov` | Cymv (suspect - looks obf) | clear_dll_xref |
| `cow` | Cymu (suspect - looks obf) | clear_dll_xref |
| `dju` | Dbtv (suspect - looks obf) | clear_dll_xref |
| `dle` | Type (suspect - looks obf) | clear_dll_xref |
| `dmr` | Dpdu (suspect - looks obf) | clear_dll_xref |
| `dop` | Daxe (suspect - looks obf) | clear_dll_xref |
| `dpg` | Category (suspect - looks obf) | clear_dll_xref |
| `dzl` | Data (suspect - looks obf) | clear_dll_xref |
| `ech` | Dgwh (suspect - looks obf) | clear_dll_xref |
| `edd` | Dqjf (suspect - looks obf) | clear_dll_xref |
| `ehj` | Diya (suspect - looks obf) | clear_dll_xref |
| `ein` | Data (suspect - looks obf) | clear_dll_xref |
| `eja` | Cyvg (suspect - looks obf) | clear_dll_xref |
| `ejd` | Djgd (suspect - looks obf) | clear_dll_xref |
| `ejm` | Cyvh (suspect - looks obf) | clear_dll_xref |
| `eno` | Daji (suspect - looks obf) | clear_dll_xref |
| `enp` | Dixi (suspect - looks obf) | clear_dll_xref |
| `env` | Cyqm (suspect - looks obf) | clear_dll_xref |
| `eoh` | Dgff (suspect - looks obf) | clear_dll_xref |
| `epo` | Dmjg (suspect - looks obf) | clear_dll_xref |
| `ept` | Dqlu (suspect - looks obf) | clear_dll_xref |
| `epu` | Diwq (suspect - looks obf) | clear_dll_xref |
| `eqc` | Dajn (suspect - looks obf) | clear_dll_xref |
| `eqe` | Dajm (suspect - looks obf) | clear_dll_xref |

**Total suspects (label looks obf or generic) : 76 sur 280**.

## 3. medium_xref sur obf (echantillon des plus plausibles)

| obf | label infere | sources |
|---|---|---|
| `gaw` | **ActionBase** | clear_dll_xref |
| `enh` | **AdminService** | clear_dll_xref |
| `eni` | **AlignmentService** | clear_dll_xref |
| `pp` | **AssetService** | inlined_strings |
| `dsj` | **AudioService** | inlined_strings |
| `ekt` | **AudioService** | inlined_strings |
| `fdj` | **AudioService** | inlined_strings |
| `etn` | **AuthUIHubService** | clear_dll_xref |
| `eny` | **BadgeService** | clear_dll_xref |
| `eto` | **BaseUiDependenciesService** | clear_dll_xref |
| `enz` | **BidHouseService** | clear_dll_xref |
| `eoc` | **BreedingService** | clear_dll_xref |
| `etp` | **BugReportHubService** | clear_dll_xref |
| `dry` | **CartographyService** | inlined_strings |
| `eah` | **CartographyUI** | inlined_strings |
| `ets` | **CharacterHubService** | clear_dll_xref |
| `bb` | **CharacterInfos** | clear_dll_xref |
| `eom` | **CharacterSelectionService** | clear_dll_xref |
| `eon` | **CommandService** | clear_dll_xref |
| `eoo` | **CommonExchangeService** | clear_dll_xref |
| `bfk` | **CrafterInfos** | clear_dll_xref |
| `dnp` | **CurrentMode** | clear_dll_xref |
| `eow` | **DebtService** | clear_dll_xref |
| `eoy` | **DialogParamsDecoderService** | clear_dll_xref |
| `fec` | **DirectoryBase** | clear_dll_xref |
| `epe` | **DocumentService** | clear_dll_xref |
| `etw` | **EffectTooltipDependencies** | clear_dll_xref |
| `enc` | **EntitiesServiceBase** | clear_dll_xref |
| `evp` | **EntitiesServiceBase** | clear_dll_xref |
| `ewg` | **EntityNPCService** | clear_dll_xref |

**Total plausibles (label avec suffixe domain-meaningful) : 124 sur 280**.

## 4. high_unique sur clear (38) - deja claires, validation DBI

Classes que DBI reference par leur nom canonique ET qui existent telles quelles dans cpp2il :

`BoolOption`, `CategoryData`, `CategorySummaryItem`, `Criterion`, `DescriptionData`, `DofusButtonCustom`, `DofusIcon`, `DofusLabel`, `DofusVisualElement`, `Edge`, `Entity`, `Fight`, `FigmaIcons`, `Floor`, `FriendList`, `IBaseTooltipBuilder`, `IOptionData`, `Interactive`, `IsColorable`, `MapTransition`, `MultipleChoiceOption`, `Option`, `OptionCategory`, `OptionElement`, `OptionType`, `SectionHeader`, `ShadowData`, `Switch`, `TaxCollectorEquipment`, `TextButtonOption`, `TextTooltipBuilder`, `ThemeConstants`, `TooltipRoot`, `Transition`, `TreasureHunt`, `Triggers`, `User`, `WindowFigma`

## 5. Pistes pour suite de session

1. **Frida runtime capture** (Task 8 manuelle) - pour les noms .proto. ~30 min, +4 a +50 descriptors.
2. **Auditer les 32 high_unique** ci-dessus, valider/corriger un par un.
3. **Filtrer les medium_xref suspects** (label = obf 3-letter ou primitive). Bumper le filtre dans extract-clear-dll-xrefs.py post-coup.
4. **Re-runner le matcher proto v3** avec les 350 ancres comme seed - peut debloquer des centaines de noms .proto via propagation graph-based.
5. **Polir le domain classifier** (Task 14) - narrow le domaine render.
