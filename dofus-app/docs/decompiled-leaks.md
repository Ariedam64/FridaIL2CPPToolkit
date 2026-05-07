# Dofus 3.0 — Decompiled-IL leaks

Extracted by walking every `.cs` file from ilspycmd's decompilation of Cpp2IL's `dll_il_recovery` output of `Core.dll`. Method bodies are stripped (`throw null`) but signatures, async state machines, parameter names, parent classes and interfaces are intact.

## Stats

- **5992** classes indexed (out of 8923 in Core.dll)
- **3773** still obfuscated, **2219** with clear names
- **514** async/lambda methods with their **original names** recovered (compiler-gen leak)
- **318** of those also have their **original parameter names + types** recovered

## Top obfuscated classes by recovered method signatures

These obfuscated classes have the most async/lambda method names + parameter info recovered. Each method line shows: `methodName(paramName: paramType, ...)`.

### `uf`
**Touching public types**: `Ankama.AddressableUtilities.Runtime`

**Recovered async/lambda methods**:
- `GenerateAnimatedElement(transform: `ClientAnimatedElementTransform`, parent: `Transform`, ownerCollectorId: `int`)`
- `GenerateCellPing(ownerCollectorId: `int`, cellId: `int`)`
- `GenerateCharacter(look: `EntityLook`, ownerCollectorId: `int`, entityId: `long`, cellId: `int`, parent: `Entity`, isVisible: `bool`, isLoadFromBoneIndex: `bool`, fromProp: `bool`, useSpawn: `bool`)`
- `GenerateCharacterForUI(animation: `EntityAnimation`, areAutoUpdates: `bool`, look: `EntityLook`, allowFightModifier: `bool`, defaultDirection: `pn`, ownerCollectorId: `int`, entityId: `long`, optionalName: `string`)`
- `GenerateCharacterInternal(fightEntity: `bool`, entityId: `long`, look: `EntityLook`, fromProp: `bool`, catalogName: `AddressableCatalogName`, ownerCollectorId: `int`, cellId: `int`, parent: `Entity`, isVisible: `bool`, isLoadFromBoneIndex: `bool`, useSpawnAnim: `bool`, idleOverride: `int`)`
- `GenerateFightOnMapTeamIcon(descr: `ezu`, collectorId: `int`)`
- `GenerateFollower(look: `EntityLook`, speedFactor: `float`, parent: `Entity`, type: `vw`)`
- `GenerateMapCharacter(look: `EntityLook`, ownerCollectorId: `int`, entityId: `long`, cellId: `int`, parent: `Entity`, isVisible: `bool`, isLoadFromBoneIndex: `bool`)`
- `GenerateMark(markId: `int`, markType: `eyv`, team: `goj`, isMarkActive: `bool`, direction: `pn`, look: `EntityLook`, ownerCollectorId: `int`, cellId: `int`, parent: `Entity`, isVisible: `bool`, isLoadFromBoneIndex: `bool`, isSpawnAnimation: `bool`)`
- `GeneratePing(look: `EntityLook`, ownerCollectorId: `int`, cellId: `int`)`
- `GeneratePreview(look: `EntityLook`, ownerCollectorId: `int`, cellId: `int`, isLoadFromBoneIndex: `bool`, direction: `pn`, entityId: `long`)`
- `GenerateProjectile(ownerCollectorId: `int`, parent: `Entity`, direction: `pn`, isRandomOrientation: `bool`, animationName: `string`, look: `EntityLook`, fromProp: `bool`, cellId: `int`, isVisible: `bool`, isLoadFromBoneIndex: `bool`)`
- `GeneratePropEffect(look: `EntityLook`, ownerCollectorId: `int`, entityId: `long`, cellId: `int`, parent: `Entity`, isVisible: `bool`, isLoadFromBoneIndex: `bool`)`
- `GenerateScenario(collectorOwner: `int`, entityId: `long`)`

### `egq`
`egq` extends `eqa`, implements `fqr`

**Touching public types**: `Com.Ankama.HaapiAnkama.Model`, `Com.Ankama.HaapiDofus.Model`

**Recovered async/lambda methods**:
- `ConsumeKardByCode(code: `string`, lang: `string`)`
- `ConsumeKardById(lang: `string`, id: `long`, gameId: `long`)`
- `CreateTokenWithPassword(account: `string`, password: `string`, game: `long`)`
- `GetAccountBids(status: `string`)`
- `GetAlmanaxEvent(lang: `string`, date: `string`)`
- `GetCmsPollInGame(site: `string`, lang: `string`, page: `long`, count: `long`)`
- `GetDirectionsRates(serverId: `long`)`
- `GetFeeds(site: `string`, lang: `string`)`
- `GetKardByAccountIdWithApiKey(lang: `string`)`
- `GetOffersKamas(serverId: `long`, orderBy: `string`, orderDir: `string`)`
- `GetOffersOgrines(serverId: `long`, orderBy: `string`, orderDir: `string`)`
- `MarkCmsPollInGamesAsRead(item: `long`)`
- `OgrinsAccount()`
- `OgrinsAmount()`
- `SendDeviceInfos(sessionId: `long`, connectionType: `string`, clientType: `string`, os: `string`, device: `string`, partner: `string`, deviceUid: `string`, sessionIdString: `string`, cancellationToken: `CancellationToken`)`
- `SendGameEvent(game: `long`, sessionId: `long`, eventId: `long`, data: `string`)`
- `SendGameEvents(game: `long`, sessionId: `long`, events: `string`)`

### `eat`
**Touching public types**: `Ankama.AddressableUtilities.Runtime`

**Recovered async/lambda methods**:
- `AddAreaShape(layer: `eax`, elementName: `string`, subAreaId: `int`, fillColor: `Color`, lineColor: `Color`, thickness: `float`, isFixed: `bool`)`
- `CenterToPlayerPosition()`
- `Display(id: `int`, center: `bool`, onDone: `Action`)`
- `DisplayWhenReady(moveToPlayer: `bool`)`
- `LoadCartographyImages(id: `int`, token: `CancellationToken`)`
- `LoadLod(lod: `double`, worldId: `int`, releasePreviousWhenDone: `bool`, refreshLodOnComplete: `bool`)`
- `OnMouseDrag()`
- `RefreshScaleAfterLoad()`
- `ToggleLayer(value: `bool`, layerName: `eax`)`
- `UpdatePrismIcon(prismSubArea: `jh`, updateWorldMapDisplay: `bool`)`
- `UpdatePrismsAsync(prisms: `List<int>`, dghj: `bool`, dgia: `eau`, dgib: `eau`, dgic: `eau`, dgid: `eau`, dgie: `eau`, dgif: `eau`)`

### `ejr`
`ejr` extends `ewf`, implements `fqq`, `fqr`, `eoa`

**Touching public types**: `Ankama.AddressableUtilities.Runtime`, `Ankama.Animations`

**Recovered async/lambda methods**:
- `GetClosestAnimFromBoneAsync(look: `EntityLook`, animName: `string`, direction: `pn`, isSilent: `bool`, definition: `AnimatedObjectDefinition`)`
- `GetClosestAsync(animName: `string`, direction: `pn`, boneId: `uint`, breed: `BreedEnum`, isSilent: `bool`)`
- `Init()`
- `LoadAndApplyDefinitionAsync(look: `EntityLook`, animator: `EntityAnimator`, isSilent: `bool`, animation: `EntityAnimation`)`
- `LoadAnimationNamesAsync(boneId: `uint`)`
- `LoadDefinitionFromBoneCatalogAsync(defId: `uint`)`
- `LoadDefinitionFromCatalogAsync(defName: `string`, catalogName: `AddressableCatalogName`)`
- `LoadDefinitionFromMappedBoneAsync(animationName: `string`, defId: `uint`, breed: `BreedEnum`, isSilent: `bool`)`
- `LoadSkin(skinId: `short`)`
- `PreLoadDefinitionFromCatalog(defName: `string`, catalogName: `AddressableCatalogName`)`
- `PreLoadSkin(skinId: `short`)`

### `emb`
`emb` extends `esl`, implements `fqr`

**Touching public types**: `Com.Ankama.Shopi.Model`

**Recovered async/lambda methods**:
- `CreateCart(cartRequest: `CartDetailClassicRequest`, cancellationToken: `CancellationToken`)`
- `CreateOrder(cartId: `string`, createOrderRequest: `CreateOrderRequest`, cancellationToken: `CancellationToken`)`
- `GetArticleInfo(articleId: `int`, cancellationToken: `CancellationToken`)`
- `GetCategoryPromoteGroup(categoryId: `int`, cancellationToken: `CancellationToken`)`
- `GetPaymentMethod(cartId: `string`, cancellationToken: `CancellationToken`)`
- `GetShopCatalog(page: `int`, sort: `SortOneOf`, categoryId: `int`, cancellationToken: `CancellationToken`)`
- `GetShopCategoryList(parentCategoryId: `string`, cancellationToken: `CancellationToken`)`
- `PayOrderFree(orderId: `string`, cancellationToken: `CancellationToken`)`
- `PayOrderOgrines(orderId: `string`, cancellationToken: `CancellationToken`)`
- `SearchArticles(text: `string`, limit: `int`, cancellationToken: `CancellationToken`)`

### `els`
`els` extends `ent`, implements `fqq`, `fqr`

**Touching public types**: `Ankama.AudioManagement`, `FMOD.Studio`

**Recovered async/lambda methods**:
- `DEBUG_LocalizedSounds()`
- `DoLoadBank(bankFullPath: `string`)`
- `DoLoadBankWithGuid(bankGuid: `string`)`
- `GenerateMapSpatializationAsync(mapData: `MapMetadata`)`
- `Init()`
- `Initialize()`
- `InitializeAudioManager()`
- `PlayMenuWhenDoneInit()`
- `PlaySound(audioGuid: `string`, look: `short`, isPlayerBark: `bool`, emitter: `Transform`, bankIdentifierFailsafe: `int`, isPlayer: `bool`, isLooped: `bool`, allowInMenu: `bool`)`
- `PlaySoundEventInstance(allowInMenu: `bool`, bankIdentifierFailsafe: `int`, audioGuid: `string`, emitter: `Transform`, addToLocalizedSounds: `bool`, isPlayerBark: `bool`, look: `short`, isPlayer: `bool`, isLooped: `bool`)`

### `ehc`
`ehc` extends `fqt`, implements `ewh`, `IEnumerable<Entity>`, `IEnumerable`, `fqs`, `fqr`

**Touching public types**: `Ankama.AddressableUtilities.Runtime`

**Recovered async/lambda methods**:
- `GenerateSprite()`
- `LoadEntity(animationName: `string`, look: `EntityLook`, isFight: `bool`, tags: `uk`, isSpawnAnimation: `bool`, catalogName: `AddressableCatalogName`, direction: `pn`, ownerEntity: `Entity`, isLoop: `bool`, entityId: `long`, cellId: `int`, isVisible: `bool`, isLoadFromBoneIndex: `bool`, label: `string`, isAlwaysDisplayedMirrored: `bool`, followedEntityId: `long`, shaderOutlineParameters: `ShaderOutlineParameters`, idleOverride: `int`, allowFightIdle: `bool`, parent: `Entity`)`

### `rj`
**Recovered async/lambda methods**:
- `CreateMaterial(data: `RenderData`, index: `int`, materialData: `ShaderData`, elementTransformWrappers: `List<gtp>`, allowMapEffects: `bool`)`
- `CreateMaterialsForMap(map: `MapMetadata`, allowMapEffects: `bool`)`
- `GetTexture(address: `string`, wrapMode: `TextureWrapMode`)`
- `InitMaterial(materialData: `ShaderData`, allowMapEffects: `bool`, material: `Material`)`
- `PopulateRenderData(renderData: `RenderData`, materialData: `MaterialData`, allowMapEffects: `bool`, elementTransformWrappers: `List<gtp>`)`

### `giw`
`giw` extends `giv`, implements `fqr`

**Recovered async/lambda methods**:
- `Run(castSequenceContext: `ghd`, specificTargetedCellId: `int`, steps: `List<frb>`, successCallback: `Action<ScriptResult>`, errorCallback: `Action<ScriptResult>`)`
- `RunDelayed(castSequenceContext: `ghd`, usageDataId: `int`, specificTargetedCellId: `int`, steps: `List<frb>`, successCallback: `Action<ScriptResult>`, errorCallback: `Action<ScriptResult>`)`
- `RunInternal(scriptContext: `gjb`, sequenceContext: `ghd`, steps: `List<frb>`, successCallback: `Action<ScriptResult>`, errorCallback: `Action<ScriptResult>`)`

### `dtf`
`dtf` extends `eti`, implements `fqr`

**Recovered async/lambda methods**:
- `Connect()`
- `GetAuthenticationToken(id: `dlt`)`
- `GetSetting(name: `string`)`
- `PayCart(shopApiKey: `string`, shopKey: `string`, cartId: `string`, onError: `Action`, onSuccess: `Action`)`
- `RequestAPIToken()`
- `RequestUserInfos()`
- `RequestZaapLanguage()`
- `RequestZaapUpdateNeeded()`
- `SetZaapLanguage(lang: `string`)`

### `eka`
`eka` extends `eol`, implements `fqr`

**Touching public types**: `Ankama.AddressableUtilities.Runtime`

**Recovered async/lambda methods**:
- `AddStylizedTextElement(entityId: `long`, positionSpawn: `Vector3`, text: `string`, type: `eol.eok`, distance: `int`, duration: `float`, delay: `float`)`
- `AddTextElement(entityId: `long`, text: `string`, color: `Color32`, positionSpawn: `Vector3`, distance: `int`, scrollDuration: `float`, delay: `float`)`
- `Initialize()`

### `eyk`
`eyk` extends `fqt`, implements `sv`, `fqs`, `fqr`

**Recovered async/lambda methods**:
- `ApplyModeTransition(newMode: `eyi`, previousMode: `eyi`)`
- `GetOrCreateCellPing(cellId: `int`, type: `sx`)`
- `ManageCellPings(pingsByCells: `MapField<int, int>`)`
- `ManageFightPings(message: `hrj`)`
- `RemovePingsAsync()`
- `SwitchRemoveMode(isInRemoveMode: `bool`)`

### `qu`
`qu` extends `IMapAnimatedElement`

**Recovered async/lambda methods**:
- `ApplyGuildCustomisation()`
- `Generate(collectorId: `int`, transform: `ClientAnimatedElementTransform`, parent: `Transform`, displayableService: `epd`, cachedDataService: `eod`, interactiveCellService: `eqk`, playedCharacterService: `erl`, guildService: `epz`, mapStagingService: `erc`, cyoi: `bool`, cyor: `bool`)`

### `fpq`
**Touching public types**: `Com.Ankama.HaapiAnkama.Client`, `Com.Ankama.HaapiDofus.Client`, `Com.Ankama.Shopi.Client`

**Recovered async/lambda methods**:
- `GetResizedSpriteFromURL(url: `string`, width: `int`, height: `int`)`
- `GetSpriteFromURL(url: `string`)`
- `GetTextureFromURL(url: `string`)`
- `HaapiRequestHandler(haapiRequest: `Func<UniTask>`, onSuccess: `Action`, onError: `Action<Com.Ankama.HaapiAnkama.Client.ApiException>`)`

### `gir`
**Recovered async/lambda methods**:
- `GeneratePortalExitsStep(sequenceParams: `SpellScriptGfxSequenceParams`, context: `gja`)`
- `GenerateStep(sequenceParams: `SpellScriptGfxSequenceParams`, context: `gja`)`
- `ToProjectilePortalExitStep(usageParams: `SpellScriptGfxUsageParams`, context: `gja`)`
- `ToProjectileSequencer(usageParams: `SpellScriptGfxUsageParams`, context: `gja`)`

### `ffy`
`ffy` extends `fqx<etp.BugReportUis>`, implements `etp`, `fqs`, `fqr`

**Touching public types**: `Ankama.Zendesk.Core.Client`

**Recovered async/lambda methods**:
- `GetTextAsync(request: `UnityWebRequest`)`
- `LoadExternalConfiguration()`
- `PostForm(customFields: `Dictionary<long, string>`, name: `string`, mail: `string`, subject: `string`, description: `string`, ticketFormId: `long`, language: `string`)`

### `eah`
`eah` extends `fpz<CartographyMapUIBinding>`

**Recovered async/lambda methods**:
- `InitStaticCartographyData()`
- `MoveTo(x: `int`, y: `int`)`
- `MoveToWorldmapMenuElement(sectionHeader: `SectionHeader`)`
- `ScheduleAnomalyListRefresh(delay: `float`)`
- `SetUpWorldMap(dgcy: `CartographyMapView`)`

### `dyt`
**Recovered async/lambda methods**:
- `GetTextFromURL(url: `string`)`
- `LoadGameActivityData(descriptor: `dys`, cultureCode: `string`)`
- `LoadGamesActivitiesLibraries(forceReload: `bool`, url: `string`, cultureCode: `string`)`

### `gox`
**Recovered async/lambda methods**:
- `Preview(context: `gqg`, forcedCasterId: `long`, castSpell: `he`)`
- `PreviewContext(context: `gqg`, casterId: `long`, castSpell: `he`, isCritical: `bool`)`

### `dvi`
`dvi` extends `ekd`, implements `erx`, `fqs`, `fqr`

**Recovered async/lambda methods**:
- `ManageSkillClickedWhenAvailable(interactiveElement: `dd`, skillInstanceId: `uint`, fromAutotrip: `bool`)`
- `UpdateStatedElement(se: `de`, global: `bool`, fromCreation: `bool`)`

### `ffx`
`ffx` extends `fqx<etn.AuthUis>`, implements `etn`, `fqs`, `fqr`

**Recovered async/lambda methods**:
- `DisplayCharacterCreation(message: `cbp`)`
- `EnableActionsMapsWhenReady()`
- `EnableCharacterSelectionWhenUnlocked(characterList: `List<BasicCharacterWrapper>`)`
- `LoadServerSelectionWhenUnlocked(message: `bcg`)`
- `RemoveLoadingAfterLoading()`

### `tc`
**Recovered async/lambda methods**:
- `GenerateRefractionSprite(transform: `ClientElementTransform`, texturePackKey: `string`, material: `Material`, parent: `GameObject`)`
- `GenerateSprite(texturesPackKey: `string`, transform: `ClientElementTransform`)`

### `fdy`
`fdy` extends `fqt`, implements `esx`, `fqr`, `fqq`

**Recovered async/lambda methods**:
- `AddToPoolOnMainThread(type: `TooltipType`, tooltipRoot: `TooltipRoot`)`
- `ShowFightPreview(builders: `ICollection<IBaseTooltipBuilder>`)`
- `SynchronizeFightPreviewTooltips(token: `CancellationToken`)`

### `fqx`
**Recovered async/lambda methods**:
- `ReplaceAfterGeometryChanged(frames: `int`, ui: `fqk`)`
- `SetUiAccordingToPresetAfterFrame()`
- `SetUiPresetAfterFrame(uiTypeID: `string`, ui: `fqk`)`

### `wi`
**Touching public types**: `Ankama.AddressableUtilities.Runtime`, `Ankama.Animations`

**Recovered async/lambda methods**:
- `Initialize(look: `EntityLook`, animation: `EntityAnimation`)`
- `LoadBone(bone: `EntityLook`, animation: `EntityAnimation`, animator: `EntityAnimator`)`

