# Dofus 3.0 — Deobfuscation map
> Live IL2CPP runtime analysis. 4 leak vectors triangulated:
>  1. **Compiler-gen leaks** — `<Method>...` nested classes leak the original method name + their declaring (obfuscated) class.
>  2. **Survived names** — classes marked `[DoNotRename]` retain Pascal-case, used as vocabulary of reference.
>  3. **Inheritance** — clear classes extending an obfuscated base reveal the base's domain.
>  4. **Type references** — field & method types reference public types (HAAPI, Protobuf, FMOD, DotNetty, BouncyCastle, DataCenter…). The obfuscator preserves type system → domain leak for free.

Coverage: 17 assemblies dumped, 105 classes deeply inspected.

## High-confidence identifications
Sorted by triangulation score (combination of leaked methods + type ref hits + clear children).

| Score | Asm | Obf | Likely role | Evidence (sample) |
|---|---|---|---|---|
| 198 | Core | `fpz`1` | **Generic UI base (large)** | methods: `WindowDragged` • children: `AchievementsUI`, `AddFriendUi`, `AdminSelectItemUI` |
| 94 | Core | `eat` | **World/cartography UI** | methods: `AddAreaShape`, `CenterToPlayerPosition`, `Display` • types: `AddressableEntry`, `DofusContextualMenu`, `SubAreaData` • children: `CartographyBannerView`, `CartographyMapView` |
| 82 | Core | `fdy` | **Entity factory (rendering)** | methods: `AddToPoolOnMainThread`, `ShowFightPreview`, `SynchronizeFightPreviewTooltips` • types: `TooltipRoot`, `IBaseTooltipBuilder`, `TooltipType` |
| 60 | Core | `els` | **Audio manager (FMOD)** | methods: `DEBUG_LocalizedSounds`, `DoLoadBank`, `DoLoadBankWithGuid` • types: `PARAMETER_ID`, `EventInstance`, `BankFlags` |
| 57 | Core | `eah` | **World/cartography UI** | methods: `InitStaticCartographyData`, `MoveTo`, `MoveToWorldmapMenuElement` • types: `CheckboxCustom`, `TerritoryItemBinding`, `ListElementBasic` |
| 56 | Core | `egq` | **HAAPI client (Ankama+Dofus)** | methods: `ConsumeKardByCode`, `ConsumeKardById`, `CreateTokenWithPassword` • types: `BakBidOffers`, `Token`, `Almanax` |
| 48 | Core | `uf` | **Entity factory (rendering)** | methods: `GenerateAnimatedElement`, `GenerateCellPing`, `GenerateCharacter` • types: `Entity`, `EntityLook`, `EntityAnimation` |
| 43 | Core | `emb` | **Shopi (Boutique) client** | methods: `CreateCart`, `CreateOrder`, `GetArticleInfo` • types: `ShopKey`, `Language`, `CategoryList` |
| 40 | Core | `dxd` | **Protocol service [SmithMagic] (75 msg handlers)** | methods: `PresetListEventWhenCharacterInfo`, `RefreshTagsWhenContentReceived` • types: `AbstractStorageView`, `ShortCutBarTypes`, `RepeatedField` |
| 30 | Core | `iso` | **?** | types: `RepeatedField`, `FieldCodec`, `MessageParser` |
| 25 | Core | `eka` | **Entity factory (rendering)** | methods: `AddStylizedTextElement`, `AddTextElement`, `Initialize` • types: `TextElement`, `StyledTextElement`, `AddressableEntry` |
| 25 | Core | `ejr` | **Entity factory (rendering)** | methods: `GetClosestAnimFromBoneAsync`, `GetClosestAsync`, `Init` • types: `EntityLook`, `BreedEnum`, `AnimatedObjectDefinition` |
| 24 | Core | `gv` | **DataCenter consumer** | methods: `DoHpRegen` • types: `EntityStat`, `StatId` |
| 24 | Core | `dvw` | **DataCenter consumer** | methods: `DelayedClearAchievements` • types: `AchievementRewardData`, `AchievementData` |
| 19 | Core | `dwj` | **DataCenter consumer** | methods: `FollowObjective`, `UnfollowObjective` • types: `QuestData`, `QuestObjectiveData`, `QuestCategoryData` |
| 18 | Core | `ehc` | **Entity factory (rendering)** | methods: `GenerateSprite`, `LoadEntity` • types: `Entity`, `EntityQuery`, `IContextMenuMaker` |
| 18 | Core | `gir` | **Entity factory (rendering)** | methods: `GeneratePortalExitsStep`, `GenerateStep`, `ToProjectilePortalExitStep` • types: `SpellScriptGfxUsageParams`, `SerialSequencer`, `MapPoint` |
| 18 | Core | `dtf` | **Boutique (cart/order)** | methods: `Connect`, `GetAuthenticationToken`, `GetSetting` |
| 16 | Core | `fpq` | **HAAPI/Shopi configuration aggregator** | methods: `GetResizedSpriteFromURL`, `GetSpriteFromURL`, `GetTextureFromURL` • types: `ApiException`, `ApiException`, `ApiException` |
| 15 | Core | `dts` | **HAAPI/Shopi configuration aggregator** | methods: `AskAccessToken`, `CheckApiKeyValidity`, `RefreshKey` • types: `Configuration`, `Configuration`, `Configuration` |
| 15 | Core | `ksj` | **?** | types: `RepeatedField`, `MessageParser`, `FieldCodec` |
| 15 | Core | `ibs` | **?** | types: `RepeatedField`, `MessageParser`, `FieldCodec` |
| 15 | Core | `hwj` | **?** | types: `RepeatedField`, `MessageParser`, `FieldCodec` |
| 15 | Core | `eyk` | **Entity factory (rendering)** | methods: `ApplyModeTransition`, `GetOrCreateCellPing`, `ManageCellPings` • types: `Entity`, `MapField`, `EntityPing` |
| 15 | Core | `irx` | **?** | types: `RepeatedField`, `MessageParser`, `FieldCodec` |
| 14 | Core | `rj` | **2D animation / sprite** | methods: `CreateMaterial`, `CreateMaterialsForMap`, `GetTexture` • types: `RenderData`, `MaterialData`, `MapMetadata` |
| 14 | Core | `ghn` | **Spell zone shape behavior (base)** | types: `Hitbox`, `EntityInfo`, `MapPoint` • children: `SpellZoneShapeBoomerangBehavior`, `SpellZoneShapeCheckerboardBehavior`, `SpellZoneShapeCircleBehavior` |
| 14 | Core | `fqd`2` | **UI base class** | children: `AllianceUI`, `AuctionHouseUI`, `EncyclopediaBaseUi` |
| 13 | Core | `exf` | **Major protocol dispatcher (66 msg handlers, domain TBD)** |  |
| 13 | Core | `gbe` | **Protobuf message dispatcher** | methods: `PrepareProcessEnqueued`, `SendNetworkMessageToClient` • types: `IMessage` |
| 13 | Core | `exm` | **Major protocol dispatcher (60 msg handlers, domain TBD)** | methods: `PrismAddOrUpdateStacked` |
| 12 | Core | `ebo` | **DataCenter consumer** | methods: `GetAnimClipInfo`, `PlayAnimFun`, `PlaySynchronizedAnim` • types: `EntityInfo`, `SerialSequencer`, `AnimFunData` |
| 12 | Core | `giw` | **DataCenter consumer** | methods: `Run`, `RunDelayed`, `RunInternal` • types: `ScriptResult`, `BoundScriptUsageData` |
| 12 | Core | `gzc` | **?** | types: `MessageParser`, `RepeatedField`, `MessageDescriptor` |
| 12 | Core | `ffx` | **?** | methods: `DisplayCharacterCreation`, `EnableActionsMapsWhenReady`, `EnableCharacterSelectionWhenUnlocked` • types: `BasicCharacterWrapper` |
| 12 | Core | `idn` | **?** | types: `MessageParser`, `RepeatedField`, `MessageDescriptor` |
| 12 | Core | `irl` | **?** | types: `MessageParser`, `RepeatedField`, `MessageDescriptor` |
| 12 | Core | `knu` | **?** | types: `MessageParser`, `RepeatedField`, `MessageDescriptor` |
| 11 | Core | `dvb` | **Protobuf message dispatcher** | methods: `ActivateSkill`, `MapChangeWhenNotMovingAnymore` • types: `RepeatedField`, `Entity`, `IMessage` |
| 9 | Core | `jcw` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `jlw` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `hfw` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `knz` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `jdk` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `gui` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `jnc` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `jrr` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `icy` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `isa` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `hvp` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `fza` | **Connection lifecycle (network)** | methods: `ConnectAsync` • types: `ISocketChannel`, `SingleThreadEventLoop` |
| 9 | Core | `idw` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `jtq` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `isy` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 9 | Core | `irk` | **?** | types: `MessageParser`, `MessageDescriptor`, `UnknownFieldSet` |
| 8 | Core | `ewy` | **Protocol service [Roleplay] (43 msg handlers)** |  |
| 8 | Core | `ejz` | **Protocol service [FightEntities] (1 msg handlers)** | methods: `CreatureModeSwitched`, `RunUpdatePositionTask`, `UpdateDisplayedEntityPositionOnceBoundsAreValidAgain` • types: `Entity`, `IRectangle` |
| 8 | Core | `ehk` | **Protocol service [Roleplay] (17 msg handlers)** | methods: `WaitForAddingObject`, `WaitForDroppingObjects`, `WaitProcessMapComplementaryInfo` • types: `EntityInfo`, `RoleplayEntitiesService` |
| 8 | Core | `exe` | **?** | methods: `DisposePendingClaimBoostRequests` • types: `RepeatedField` |
| 8 | Core | `fan` | **Protocol dispatcher (12 msg handlers)** | methods: `DelayPlacementDisplay` • types: `RepeatedField` |

## Detailed identifications (top 30)

### `fpz`1` — Generic UI base (large)
Assembly: `Core` · Score: 198

**Leaked methods (1)**: `WindowDragged`

**Clear subclasses (196)**: `AchievementsUI`, `AddFriendUi`, `AdminSelectItemUI`, `AllianceAvaUi`, `AllianceConquestsUi`, `AllianceFightUi`, `AllianceLogBook`, `AllianceNuggetValidPopup`, `AlmanaxEventDetails`, `AlterationUI`, `AppearanceUI`, `AuctionHouseEffectFilter`, `AuctionHouseItemsList`, `AuctionHouseSellUi`, `AuctionHouseTab`1` …

**Inferred domains**: UI(1)


### `eat` — World/cartography UI
Assembly: `Core` · Score: 94

**Leaked methods (12)**: `AddAreaShape`, `CenterToPlayerPosition`, `Display`, `DisplayWhenReady`, `LoadCartographyImages`, `LoadLod`, `OnMouseDrag`, `RefreshScaleAfterLoad`, `ToggleLayer`, `UpdateIcons`, `UpdatePrismIcon`, `UpdatePrismsAsync`

**Top type references**:
- `Ankama.AddressableUtilities.Runtime.AddressableEntry` × 19
- `Core.UILogic.Components.ContextMenu.DofusContextualMenu` × 18
- `Core.DataCenter.Metadata.World.SubAreaData` × 9
- `Core.UILogic.Components.Tooltips.Builder.CartographyTooltipBuilder.CartographyTooltipInfos` × 9
- `Core.UILogic.Components.ContextMenu.ContextMenuItem.ContextMenuItemView` × 7
- `Core.DataCenter.Metadata.World.MapInformationData` × 6
- `Core.DataCenter.Metadata.Quest.QuestData` × 5
- `Core.DataCenter.Types.Point` × 5
- `Core.DataCenter.Metadata.World.WorldMapData` × 4
- `Core.DataCenter.Metadata.World.HintData` × 2

**Clear subclasses (2)**: `CartographyBannerView`, `CartographyMapView`

**Inferred domains**: UI(35), DataCenter(31), World(2), Movement(1), Trade(1)


### `fdy` — Entity factory (rendering)
Assembly: `Core` · Score: 82

**Leaked methods (3)**: `AddToPoolOnMainThread`, `ShowFightPreview`, `SynchronizeFightPreviewTooltips`

**Top type references**:
- `Core.UILogic.Components.Tooltips.TooltipRoot` × 33
- `Core.UILogic.Components.Tooltips.Builder.IBaseTooltipBuilder` × 21
- `Core.UILogic.Components.Tooltips.TooltipType` × 7
- `Core.UILogic.Components.Tooltips.Builder.ITooltipPinnable` × 6
- `Core.UILogic.Components.Tooltips.Builder.Internal.TooltipPositioning` × 5
- `Core.UILogic.Components.Tooltips.DofusTooltipsSettings` × 2
- `Core.UILogic.Components.Tooltips.TooltipSyncHandler` × 1
- `Core.UILogic.Components.Tooltips.TooltipAdditionalType` × 1
- `Core.Rendering.Entity.Entity` × 1

**Inferred domains**: UI(77), Combat(1)


### `els` — Audio manager (FMOD)
Assembly: `Core` · Score: 60

**Leaked methods (10)**: `DEBUG_LocalizedSounds`, `DoLoadBank`, `DoLoadBankWithGuid`, `GenerateMapSpatializationAsync`, `Init`, `Initialize`, `InitializeAudioManager`, `PlayMenuWhenDoneInit`, `PlaySound`, `PlaySoundEventInstance`

**Top type references**:
- `FMOD.Studio.PARAMETER_ID` × 21
- `FMOD.Studio.EventInstance` × 8
- `Ankama.AudioManagement.BankFlags` × 5
- `Core.World.Metadata.Maps.MapMetadata` × 3
- `Ankama.AudioManagement.MusicInstance` × 2
- `AleCore.Data.Sound.PlaylistSet` × 2
- `Ankama.AudioManagement.AudioManagerLibrary` × 1
- `Ankama.AudioManagement.AudioManagerSettings` × 1
- `Core.Rendering.Entity.Entity` × 1

**Inferred domains**: Audio(42), World(1), UI(1)


### `eah` — World/cartography UI
Assembly: `Core` · Score: 57

**Leaked methods (6)**: `InitStaticCartographyData`, `MoveTo`, `MoveToWorldmapMenuElement`, `ScheduleAnomalyListRefresh`, `SetUpWorldMap`, `SwitchToConquestOrAnomalyMode`

**Top type references**:
- `Core.UILogic.Components.Figma.CheckboxCustom` × 17
- `Core.UILogic.Bindings.TerritoryItemBinding` × 10
- `Core.UILogic.Components.Figma.ListElementBasic` × 5
- `Core.DataCenter.Metadata.World.SubAreaData` × 4
- `Core.UILogic.Components.SelectableGroup` × 2
- `Core.UILogic.Components.Tooltips.Builder.IBaseTooltipBuilder` × 2
- `Core.DataCenter.Metadata.World.DungeonData` × 1
- `Core.DataCenter.Metadata.World.HintData` × 1
- `Core.Services.Roleplay.CartographyService.CartographyMapView` × 1
- `Core.Services.Roleplay.CartographyService.CartographyTool` × 1

**Inferred domains**: UI(37), DataCenter(6), World(3), Movement(1), Trade(1)


### `egq` — HAAPI client (Ankama+Dofus)
Assembly: `Core` · Score: 56

**Leaked methods (17)**: `ConsumeKardByCode`, `ConsumeKardById`, `CreateTokenWithPassword`, `GetAccountBids`, `GetAlmanaxEvent`, `GetCmsPollInGame`, `GetDirectionsRates`, `GetFeeds`, `GetKardByAccountIdWithApiKey`, `GetOffersKamas`, `GetOffersOgrines`, `MarkCmsPollInGamesAsRead`, `OgrinsAccount`, `OgrinsAmount`, `SendDeviceInfos`, `SendGameEvent`, `SendGameEvents`

**Top type references**:
- `Com.Ankama.HaapiDofus.Model.BakBidOffers` × 2
- `Com.Ankama.HaapiAnkama.Model.Token` × 1
- `Com.Ankama.HaapiAnkama.Model.Almanax` × 1
- `Com.Ankama.HaapiAnkama.Model.CmsPollInGame` × 1
- `Com.Ankama.HaapiAnkama.Model.KardTicket` × 1
- `Com.Ankama.HaapiAnkama.Model.KardKard` × 1
- `Com.Ankama.HaapiAnkama.Model.KardKardStock` × 1
- `Com.Ankama.HaapiAnkama.Model.MoneyOgrine` × 1
- `Com.Ankama.HaapiAnkama.Model.MoneyBalance` × 1
- `Com.Ankama.HaapiDofus.Model.BakBid` × 1

**Inferred domains**: HAAPI(13), Auth(3), Cms(2), Combat(1), Movement(1)


### `uf` — Entity factory (rendering)
Assembly: `Core` · Score: 48

**Leaked methods (14)**: `GenerateAnimatedElement`, `GenerateCellPing`, `GenerateCharacter`, `GenerateCharacterForUI`, `GenerateCharacterInternal`, `GenerateFightOnMapTeamIcon`, `GenerateFollower`, `GenerateMapCharacter`, `GenerateMark`, `GeneratePing`, `GeneratePreview`, `GenerateProjectile`, `GeneratePropEffect`, `GenerateScenario`

**Top type references**:
- `Core.Rendering.Entity.Entity` × 55
- `Core.Rendering.Look.EntityLook` × 18
- `Core.Rendering.Entity.Animations.EntityAnimation` × 5
- `Editor.AleCore.Data.ClientAnimatedElementTransform` × 5
- `Ankama.AddressableUtilities.Runtime.AddressableCatalogName` × 2

**Inferred domains**: Combat(1), Movement(1), World(1), UI(1), Anim(1)


### `emb` — Shopi (Boutique) client
Assembly: `Core` · Score: 43

**Leaked methods (10)**: `CreateCart`, `CreateOrder`, `GetArticleInfo`, `GetCategoryPromoteGroup`, `GetPaymentMethod`, `GetShopCatalog`, `GetShopCategoryList`, `PayOrderFree`, `PayOrderOgrines`, `SearchArticles`

**Top type references**:
- `Com.Ankama.Shopi.Model.ShopKey` × 1
- `Com.Ankama.Shopi.Model.Language` × 1
- `Com.Ankama.Shopi.Model.CategoryList` × 1
- `Com.Ankama.Shopi.Model.CatalogPage` × 1
- `Com.Ankama.Shopi.Model.SortOneOf` × 1
- `Com.Ankama.Shopi.Model.PromoteGroup` × 1
- `Com.Ankama.Shopi.Model.ArticleList` × 1
- `Com.Ankama.Shopi.Model.Article` × 1
- `Com.Ankama.Shopi.Model.Cart` × 1
- `Com.Ankama.Shopi.Model.CartDetailClassicRequest` × 1

**Inferred domains**: Boutique(21), Trade(3), Money(1)


### `dxd` — Protocol service [SmithMagic] (75 msg handlers)
Assembly: `Core` · Score: 40

**Leaked methods (2)**: `PresetListEventWhenCharacterInfo`, `RefreshTagsWhenContentReceived`

**Top type references**:
- `Core.UILogic.Inventory.Views.AbstractStorageView` × 10
- `Core.DataCenter.Metadata.Enums.ShortCutBarTypes` × 5
- `Google.Protobuf.Collections.RepeatedField` × 5
- `Core.UILogic.Inventory.Inventory` × 2

**Inferred domains**: UI(12), Network(6), DataCenter(5)


### `iso` — ?
Assembly: `Core` · Score: 30

**Top type references**:
- `Google.Protobuf.Collections.RepeatedField` × 14
- `Google.Protobuf.FieldCodec` × 7
- `Google.Protobuf.MessageParser` × 2
- `Google.Protobuf.Reflection.MessageDescriptor` × 2
- `Google.Protobuf.UnknownFieldSet` × 1
- `Google.Protobuf.CodedOutputStream` × 1
- `Google.Protobuf.WriteContext` × 1
- `Google.Protobuf.CodedInputStream` × 1
- `Google.Protobuf.ParseContext` × 1

**Inferred domains**: Network(30)


### `eka` — Entity factory (rendering)
Assembly: `Core` · Score: 25

**Leaked methods (3)**: `AddStylizedTextElement`, `AddTextElement`, `Initialize`

**Top type references**:
- `Core.UILogic.Components.CharacteristicContextual.TextElement` × 9
- `Core.UILogic.Components.CharacteristicContextual.StyledTextElement` × 9
- `Ankama.AddressableUtilities.Runtime.AddressableEntry` × 4
- `Core.Rendering.Entity.Entity` × 2

**Inferred domains**: UI(18)


### `ejr` — Entity factory (rendering)
Assembly: `Core` · Score: 25

**Leaked methods (11)**: `GetClosestAnimFromBoneAsync`, `GetClosestAsync`, `Init`, `LoadAndApplyDefinitionAsync`, `LoadAnimationNamesAsync`, `LoadDefinitionFromBoneCatalogAsync`, `LoadDefinitionFromCatalogAsync`, `LoadDefinitionFromMappedBoneAsync`, `LoadSkin`, `PreLoadDefinitionFromCatalog`, `PreLoadSkin`

**Top type references**:
- `Core.Rendering.Look.EntityLook` × 28
- `Core.Enums.BreedEnum` × 17
- `Ankama.Animations.AnimatedObjectDefinition` × 15
- `Core.Rendering.Entity.Animations.EntityAnimation` × 11
- `Ankama.AddressableUtilities.Runtime.AddressableCatalogName` × 10
- `Ankama.Animations.SkinAsset` × 2
- `Core.Rendering.Entity.Animations.EntityAnimator` × 2
- `Core.Characters.Data.BonesLabelEventsIndexData` × 1
- `Core.Characters.Data.BoneIndexData` × 1
- `Core.Services.Entities.EntityInformationServices.EntityInfo` × 1

**Inferred domains**: Anim(2), Data(2), World(1), Boutique(1)


### `gv` — DataCenter consumer
Assembly: `Core` · Score: 24

**Leaked methods (1)**: `DoHpRegen`

**Top type references**:
- `Core.Wrappers.DataCenterWrappers.StatWrappers.EntityStat` × 24
- `Core.DataCenter.Metadata.Stat.StatId` × 22

**Inferred domains**: DataCenter(22), Combat(1)


### `dvw` — DataCenter consumer
Assembly: `Core` · Score: 24

**Leaked methods (1)**: `DelayedClearAchievements`

**Top type references**:
- `Core.DataCenter.Metadata.Quest.AchievementRewardData` × 16
- `Core.DataCenter.Metadata.Quest.AchievementData` × 4

**Inferred domains**: DataCenter(20), Quest(1), Time(1)


### `dwj` — DataCenter consumer
Assembly: `Core` · Score: 19

**Leaked methods (2)**: `FollowObjective`, `UnfollowObjective`

**Top type references**:
- `Core.DataCenter.Metadata.Quest.QuestData` × 10
- `Core.DataCenter.Metadata.Quest.QuestObjectiveData` × 5
- `Core.DataCenter.Metadata.Quest.QuestCategoryData` × 1

**Inferred domains**: DataCenter(16), Quest(1)


### `ehc` — Entity factory (rendering)
Assembly: `Core` · Score: 18

**Leaked methods (2)**: `GenerateSprite`, `LoadEntity`

**Top type references**:
- `Core.Rendering.Entity.Entity` × 52
- `Core.Rendering.Entity.EntityQuery` × 11
- `Core.UILogic.Components.ContextMenu.ContextMenuFactory.IContextMenuMaker` × 5
- `Core.Rendering.Look.EntityLook` × 4
- `Ankama.AddressableUtilities.Runtime.AddressableCatalogName` × 4
- `AleCore.Parameters.Shader.ShaderOutlineParameters` × 4
- `Core.Rendering.Entity.Sprites.EntitySprite` × 2

**Inferred domains**: UI(5), Audio(4), Render(1)


### `gir` — Entity factory (rendering)
Assembly: `Core` · Score: 18

**Leaked methods (4)**: `GeneratePortalExitsStep`, `GenerateStep`, `ToProjectilePortalExitStep`, `ToProjectileSequencer`

**Top type references**:
- `Core.DataCenter.Metadata.Spell.SpellScriptGfxUsageParams` × 9
- `Core.Engine.Sequencing.SerialSequencer` × 8
- `Core.PathFinding.WorldData.MapPoint` × 6
- `Core.Rendering.Entity.Entity` × 4
- `Core.DataCenter.Metadata.Spell.SpellScriptGfxSequenceParams` × 2
- `Core.Engine.Sequencing.Steps.ProjectileStep` × 1
- `Core.DataCenter.Metadata.Spell.ParallelExecutionEndPolicy` × 1

**Inferred domains**: DataCenter(12)


### `dtf` — Boutique (cart/order)
Assembly: `Core` · Score: 18

**Leaked methods (9)**: `Connect`, `GetAuthenticationToken`, `GetSetting`, `PayCart`, `RequestAPIToken`, `RequestUserInfos`, `RequestZaapLanguage`, `RequestZaapUpdateNeeded`, `SetZaapLanguage`

**Inferred domains**: Auth(2), Network(1), Trade(1), Quest(1), Login(1)


### `fpq` — HAAPI/Shopi configuration aggregator
Assembly: `Core` · Score: 16

**Leaked methods (4)**: `GetResizedSpriteFromURL`, `GetSpriteFromURL`, `GetTextureFromURL`, `HaapiRequestHandler`

**Top type references**:
- `Com.Ankama.HaapiAnkama.Client.ApiException` × 2
- `Com.Ankama.HaapiDofus.Client.ApiException` × 2
- `Com.Ankama.Shopi.Client.ApiException` × 2

**Inferred domains**: HAAPI(4), Render(2), Boutique(2), Network(1), Quest(1)


### `dts` — HAAPI/Shopi configuration aggregator
Assembly: `Core` · Score: 15

**Leaked methods (3)**: `AskAccessToken`, `CheckApiKeyValidity`, `RefreshKey`

**Top type references**:
- `Com.Ankama.HaapiDofus.Client.Configuration` × 3
- `Com.Ankama.HaapiAnkama.Client.Configuration` × 3
- `Com.Ankama.Shopi.Client.Configuration` × 3

**Inferred domains**: HAAPI(6), Boutique(3), Auth(2), Crypto(1)


### `ksj` — ?
Assembly: `Core` · Score: 15

**Top type references**:
- `Google.Protobuf.Collections.RepeatedField` × 4
- `Google.Protobuf.MessageParser` × 2
- `Google.Protobuf.FieldCodec` × 2
- `Google.Protobuf.Reflection.MessageDescriptor` × 2
- `Google.Protobuf.UnknownFieldSet` × 1
- `Google.Protobuf.CodedOutputStream` × 1
- `Google.Protobuf.WriteContext` × 1
- `Google.Protobuf.CodedInputStream` × 1
- `Google.Protobuf.ParseContext` × 1

**Inferred domains**: Network(15)


### `ibs` — ?
Assembly: `Core` · Score: 15

**Top type references**:
- `Google.Protobuf.Collections.RepeatedField` × 4
- `Google.Protobuf.MessageParser` × 2
- `Google.Protobuf.FieldCodec` × 2
- `Google.Protobuf.Reflection.MessageDescriptor` × 2
- `Google.Protobuf.UnknownFieldSet` × 1
- `Google.Protobuf.CodedOutputStream` × 1
- `Google.Protobuf.WriteContext` × 1
- `Google.Protobuf.CodedInputStream` × 1
- `Google.Protobuf.ParseContext` × 1

**Inferred domains**: Network(15)


### `hwj` — ?
Assembly: `Core` · Score: 15

**Top type references**:
- `Google.Protobuf.Collections.RepeatedField` × 4
- `Google.Protobuf.MessageParser` × 2
- `Google.Protobuf.FieldCodec` × 2
- `Google.Protobuf.Reflection.MessageDescriptor` × 2
- `Google.Protobuf.UnknownFieldSet` × 1
- `Google.Protobuf.CodedOutputStream` × 1
- `Google.Protobuf.WriteContext` × 1
- `Google.Protobuf.CodedInputStream` × 1
- `Google.Protobuf.ParseContext` × 1

**Inferred domains**: Network(15)


### `eyk` — Entity factory (rendering)
Assembly: `Core` · Score: 15

**Leaked methods (6)**: `ApplyModeTransition`, `GetOrCreateCellPing`, `ManageCellPings`, `ManageFightPings`, `RemovePingsAsync`, `SwitchRemoveMode`

**Top type references**:
- `Core.Rendering.Entity.Entity` × 6
- `Google.Protobuf.Collections.MapField` × 3
- `Core.Rendering.World.EntityPing` × 2
- `Core.Rendering.World.CellPing` × 2
- `Core.UILogic.CursorType` × 1

**Inferred domains**: Network(3), Movement(2), Combat(1), UI(1)


### `irx` — ?
Assembly: `Core` · Score: 15

**Top type references**:
- `Google.Protobuf.Collections.RepeatedField` × 4
- `Google.Protobuf.MessageParser` × 2
- `Google.Protobuf.FieldCodec` × 2
- `Google.Protobuf.Reflection.MessageDescriptor` × 2
- `Google.Protobuf.UnknownFieldSet` × 1
- `Google.Protobuf.CodedOutputStream` × 1
- `Google.Protobuf.WriteContext` × 1
- `Google.Protobuf.CodedInputStream` × 1
- `Google.Protobuf.ParseContext` × 1

**Inferred domains**: Network(15)


### `rj` — 2D animation / sprite
Assembly: `Core` · Score: 14

**Leaked methods (5)**: `CreateMaterial`, `CreateMaterialsForMap`, `GetTexture`, `InitMaterial`, `PopulateRenderData`

**Top type references**:
- `Runtime.Metadata.Maps.RenderData` × 6
- `Editor.AleCore.Data.MaterialData` × 4
- `Core.World.Metadata.Maps.MapMetadata` × 3
- `Editor.AleCore.Data.Staging.StagingManager` × 2
- `Editor.AleCore.Data.ShaderData` × 2

**Inferred domains**: Render(2), World(1), UI(1)


### `ghn` — Spell zone shape behavior (base)
Assembly: `Core` · Score: 14

**Top type references**:
- `Core.Hitboxes.Hitbox` × 6
- `Core.Services.Entities.EntityInformationServices.EntityInfo` × 2
- `Core.PathFinding.WorldData.MapPoint` × 1

**Clear subclasses (14)**: `SpellZoneShapeBoomerangBehavior`, `SpellZoneShapeCheckerboardBehavior`, `SpellZoneShapeCircleBehavior`, `SpellZoneShapeConeBehavior`, `SpellZoneShapeCrossBehavior`, `SpellZoneShapeForkBehavior`, `SpellZoneShapeHalfCircleBehavior`, `SpellZoneShapeLineBehavior`, `SpellZoneShapeLineFromCasterBehavior`, `SpellZoneShapeOutsideComplexCircleBehavior`, `SpellZoneShapePerpendicularLineBehavior`, `SpellZoneShapeRectangleBehavior`, `SpellZoneShapeSquareBehavior`, `SpellZoneShapeWholeMapBehavior`


### `fqd`2` — UI base class
Assembly: `Core` · Score: 14

**Clear subclasses (14)**: `AllianceUI`, `AuctionHouseUI`, `EncyclopediaBaseUi`, `ForgettableBaseUI`1`, `GuidebookBaseUi`, `GuildUI`, `LadderUI`, `OptionBaseUi`, `PvpArenaBaseUi`, `SmileyUI`, `SocialBaseUI`, `UIFightResultBase`1`, `WebBakUi`, `WebBaseUi`


### `exf` — Major protocol dispatcher (66 msg handlers, domain TBD)
Assembly: `Core` · Score: 13


### `gbe` — Protobuf message dispatcher
Assembly: `Core` · Score: 13

**Leaked methods (2)**: `PrepareProcessEnqueued`, `SendNetworkMessageToClient`

**Top type references**:
- `Google.Protobuf.IMessage` × 6

**Inferred domains**: Network(9), Chat(1)


## Inheritance leaks (obfuscated base classes)
| Obf base | Children | Sample |
|---|---|---|
| `fpz`1` | 196 | AchievementsUI, AddFriendUi, AdminSelectItemUI, AllianceAvaUi, AllianceConquestsUi … |
| `fqd`2` | 14 | AllianceUI, AuctionHouseUI, EncyclopediaBaseUi, ForgettableBaseUI`1, GuidebookBaseUi … |
| `ghn` | 14 | SpellZoneShapeBoomerangBehavior, SpellZoneShapeCheckerboardBehavior, SpellZoneShapeCircleBehavior, SpellZoneShapeConeBehavior, SpellZoneShapeCrossBehavior … |
| `fqb`1` | 6 | AlignmentUi, BaseZaapSelectionUI, NpcStoreUi, SocialGroupCardUI, SocialGroupCreatorUi … |
| `fqy` | 5 | ClickMarkerStep, FightInvisibleTemporarilyDetectedStep, FightThrowCharacterStep, ProjectileInLineStep, ProjectileStep |
| `fqh`1` | 4 | BannerMenu, CharacterInformation, EndTurnWidgetUI, UIActionBar |
| `fqu` | 2 | DisplayableService, RoleplayIntroductionService |
| `fec`1` | 2 | AllianceDirectory, GuildDirectory |
| `eat` | 2 | CartographyBannerView, CartographyMapView |
| `ekd` | 2 | FightEntitiesService, RoleplayEntitiesService |
| `co` | 1 | EmptyActivity |
| `fqg`2` | 1 | BreedingUi |
| `lf` | 1 | GroupFeatureCriterion |
| `fqt` | 1 | MapDisplayService |
