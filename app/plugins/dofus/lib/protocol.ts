// Friendly-label spec for the Dofus Trade Center protocol. The agent never
// sees obfuscated names directly — at each call we resolve every entry below
// against the LabelStore (friendly → current obf) with a hardcoded fallback
// for the case where the label hasn't been set yet.
//
// To make this resilient across game updates: rename each obf class/field/
// method to the matching `friendly` value via the labels UI. Once renamed,
// the migration engine re-keys the LabelStore on each new build via signature
// matching, and resolution keeps working without code changes.
//
// Friendly names below match the convention observed in the user's WS
// captures (BidHouse* for protocol classes). Field-level friendlies likewise
// mirror the names visible in the network panel, so a fresh recording's
// `label` attributes line up directly.
//
// IMPORTANT: the shape of TRADE_CENTER_PROTO must mirror the
// `TradeCenterProto` interface defined on the agent side at
// src/rpc-agent/plugins/dofus/actions/trade-center.ts. Both sides are checked
// independently by tsc — keep them in sync.

export interface ProtoClassSpec {
    /** Friendly label set by the user via the labels UI. */
    friendly: string;
    /** Current obf name used when no label exists yet. */
    fallback: string;
}

export interface ProtoMemberSpec {
    /** Key in the `classes` map this member belongs to. */
    classKey: string;
    friendly: string;
    fallback: string;
}

export const TRADE_CENTER_PROTO = {
    classes: {
        OpenRequest:      { friendly: "BidHouseOpenRequest",                fallback: "iev" },
        OpenResponse:     { friendly: "BidHouseItemListMessage",            fallback: "iei" },
        SelectRequest:    { friendly: "BidHouseItemFilter",                 fallback: "jev" },
        SelectResponse:   { friendly: "BidHouseListItems",                  fallback: "jew" },
        DetailRequest:    { friendly: "BidHouseObjectOffersRequest",        fallback: "jej" },
        DetailResponse:   { friendly: "BidHouseItemOffers",                 fallback: "jfk" },
        Offer:            { friendly: "BidHouseOffer",                      fallback: "jfi" },
        BuyRequest:       { friendly: "BidHouseBuyAction",                  fallback: "jil" },
        TransactionState: { friendly: "BidHouseTransactionState",           fallback: "jem" },
        Dispatcher:       { friendly: "Network.OutgoingDispatcher",         fallback: "ecx" },
        BidHouseService:  { friendly: "TradeCenter.BidHouseService",        fallback: "enf" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        // OpenRequest (iev) — 5 fields, position-sensitive in protobuf.
        // ecop is null in observations; ecou (8746 in our sample) appears
        // to be an additional id alongside the map elementId — kept exposed.
        OpenRequest_field0:          { classKey: "OpenRequest",      friendly: "field0",        fallback: "ecop" },
        OpenRequest_flag1:           { classKey: "OpenRequest",      friendly: "flag1",         fallback: "ecoq" },
        OpenRequest_interactionId:   { classKey: "OpenRequest",      friendly: "interactionId", fallback: "ecos" },
        OpenRequest_extra:           { classKey: "OpenRequest",      friendly: "extra",         fallback: "ecou" },
        OpenRequest_flag2:           { classKey: "OpenRequest",      friendly: "flag2",         fallback: "ecox" },

        // OpenResponse (iei)
        OpenResponse_objects:        { classKey: "OpenResponse",     friendly: "objects",       fallback: "eclm" },
        OpenResponse_timestamp:      { classKey: "OpenResponse",     friendly: "timestamp",     fallback: "eclo" },

        // SelectRequest (jev)
        SelectRequest_typeId:        { classKey: "SelectRequest",    friendly: "typeId",        fallback: "eiwj" },
        SelectRequest_active:        { classKey: "SelectRequest",    friendly: "active",        fallback: "eiwl" },

        // SelectResponse (jew)
        SelectResponse_typeId:       { classKey: "SelectResponse",   friendly: "typeId",        fallback: "eiws" },
        SelectResponse_itemIds:      { classKey: "SelectResponse",   friendly: "itemIds",       fallback: "eiwq" },

        // DetailRequest (jej)
        DetailRequest_show:          { classKey: "DetailRequest",    friendly: "show",          fallback: "eitv" },
        DetailRequest_objectId:      { classKey: "DetailRequest",    friendly: "objectId",      fallback: "eitz" },

        // DetailResponse (jfk)
        DetailResponse_object:       { classKey: "DetailResponse",   friendly: "object",        fallback: "ejai" },
        DetailResponse_typeId:       { classKey: "DetailResponse",   friendly: "typeId",        fallback: "ejam" },
        DetailResponse_itemId:       { classKey: "DetailResponse",   friendly: "itemId",        fallback: "ejao" },

        // Offer (jfi) — one entry per HDV listing inside DetailResponse.object.
        // eizp / eizr were null in our sample; reserved for later naming.
        Offer_typeId:                { classKey: "Offer",            friendly: "typeId",        fallback: "eizt" },
        Offer_itemId:                { classKey: "Offer",            friendly: "itemId",        fallback: "eizv" },
        Offer_auctionId:             { classKey: "Offer",            friendly: "auctionId",     fallback: "eizx" },
        Offer_stats:                 { classKey: "Offer",            friendly: "stats",         fallback: "ejaa" },
        Offer_prices:                { classKey: "Offer",            friendly: "prices",        fallback: "ejad" },

        // BuyRequest (jil) — outgoing buy packet, must echo a price the
        // server matches against the current listing (anti rug-pull).
        BuyRequest_quantity:         { classKey: "BuyRequest",       friendly: "quantity",      fallback: "ejue" },
        BuyRequest_price:            { classKey: "BuyRequest",       friendly: "price",         fallback: "ejug" },
        BuyRequest_auctionId:        { classKey: "BuyRequest",       friendly: "auctionId",     fallback: "ejui" },

        // TransactionState (jem) — universal confirmation, fires on success
        // AND failure (e.g. inventory full → success=false).
        TransactionState_auctionId:  { classKey: "TransactionState", friendly: "auctionId",     fallback: "eiur" },
        TransactionState_success:    { classKey: "TransactionState", friendly: "success",       fallback: "eiut" },

        BidHouseService_typeIdsList: { classKey: "BidHouseService",  friendly: "typeIdsList",   fallback: "dkri" },
        BidHouseService_searchCache: { classKey: "BidHouseService",  friendly: "searchCache",   fallback: "dkre" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        Dispatcher_send:        { classKey: "Dispatcher",      friendly: "sendOutgoing",     fallback: "xby" },
        BidHouseService_search: { classKey: "BidHouseService", friendly: "searchByTypeIds", fallback: "bbex" },
    } as Record<string, ProtoMemberSpec>,
} as const;

/** Shape of the resolved proto delivered to the agent. Keep in sync with
 *  TradeCenterProto on the agent side. */
export interface ResolvedTradeCenterProto {
    classes: Record<keyof typeof TRADE_CENTER_PROTO["classes"], string>;
    fields:  Record<keyof typeof TRADE_CENTER_PROTO["fields"],  string>;
    methods: Record<keyof typeof TRADE_CENTER_PROTO["methods"], string>;
}

// =============================================================================
// MapComplementaryInformationsDataMessage (itx) — incoming on map entry,
// holds every interactive on the map with their (server-allocated) skill UIDs.
// Used by MapInteractivesStore to index interactives per-map without any
// hardcoded obfuscated names. Same migration story as TRADE_CENTER_PROTO.
// =============================================================================

export const MAP_INFO_PROTO = {
    classes: {
        Message:       { friendly: "mapInfo",                fallback: "itx" },
        Interactive:   { friendly: "InteractiveElement",     fallback: "kne" },
        Skill:         { friendly: "InteractiveElementSkill",fallback: "knc" },
        StatedElement: { friendly: "StatedElement",          fallback: "kdb" },
        StateUpdate:   { friendly: "statedElementUpdated",   fallback: "ieu" },
        ElementUpdate: { friendly: "interactiveElementUpdated",fallback: "iet" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        Message_mapId:                 { classKey: "Message",       friendly: "mapId",            fallback: "efti" },
        Message_interactives:          { classKey: "Message",       friendly: "interactives",     fallback: "eftt" },
        Message_statedElements:        { classKey: "Message",       friendly: "statedElements",   fallback: "eftq" },
        Interactive_elementId:         { classKey: "Interactive",   friendly: "elementId",        fallback: "erqk" },
        Interactive_interactiveTypeId: { classKey: "Interactive",   friendly: "interactiveTypeId",fallback: "erqx" },
        Interactive_enabledSkills:     { classKey: "Interactive",   friendly: "enabledSkills",    fallback: "erqn" },
        Interactive_disabledSkills:    { classKey: "Interactive",   friendly: "disabledSkills",   fallback: "erqv" },
        Skill_skillId:                 { classKey: "Skill",         friendly: "skillId",          fallback: "erpy" },
        Skill_skillInstanceUid:        { classKey: "Skill",         friendly: "skillInstanceUid", fallback: "erqd" },
        StatedElement_state:           { classKey: "StatedElement", friendly: "state",            fallback: "eoun" },
        StatedElement_onCurrentMap:    { classKey: "StatedElement", friendly: "isVisible",     fallback: "eoup" },
        StatedElement_elementId:       { classKey: "StatedElement", friendly: "elementId",        fallback: "eour" },
        StatedElement_cell:            { classKey: "StatedElement", friendly: "cell",             fallback: "eout" },
        StateUpdate_payload:           { classKey: "StateUpdate",   friendly: "statedElement",    fallback: "econ" },
        ElementUpdate_payload:         { classKey: "ElementUpdate", friendly: "interactive",      fallback: "ecoj" },
    } as Record<string, ProtoMemberSpec>,
    methods: {} as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedMapInfoProto {
    classes: Record<keyof typeof MAP_INFO_PROTO["classes"], string>;
    fields:  Record<keyof typeof MAP_INFO_PROTO["fields"],  string>;
    methods: Record<keyof typeof MAP_INFO_PROTO["methods"], string>;
}

// =============================================================================
// InteractiveUseRequest (iev) — same wire class as the trade-center "open"
// request because opening an HDV is just a useInteractive on the merchant NPC.
// We expose it under semantic field names (elementId / skillInstanceUid)
// because for harvest actions those are what the caller thinks in. The
// LabelStore is shared with TC: whichever friendly the user picked for `iev`
// (BidHouseOpenRequest or InteractiveUseRequest), the obf falls back to "iev"
// and resolution still works for both protos.
// =============================================================================

export const INTERACTIVE_PROTO = {
    classes: {
        UseRequest: { friendly: "InteractiveUseRequest",       fallback: "iev" },
        Dispatcher: { friendly: "Network.OutgoingDispatcher",  fallback: "ecx" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        UseRequest_flag1:            { classKey: "UseRequest", friendly: "flag1",            fallback: "ecoq" },
        UseRequest_elementId:        { classKey: "UseRequest", friendly: "elementId",        fallback: "ecos" },
        UseRequest_skillInstanceUid: { classKey: "UseRequest", friendly: "skillInstanceUid", fallback: "ecou" },
        UseRequest_flag2:            { classKey: "UseRequest", friendly: "flag2",            fallback: "ecox" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        Dispatcher_send: { classKey: "Dispatcher", friendly: "sendOutgoing", fallback: "xby" },
    } as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedInteractiveProto {
    classes: Record<keyof typeof INTERACTIVE_PROTO["classes"], string>;
    fields:  Record<keyof typeof INTERACTIVE_PROTO["fields"],  string>;
    methods: Record<keyof typeof INTERACTIVE_PROTO["methods"], string>;
}

// =============================================================================
// MapMoveRequest (isa) — outgoing pathfinding packet. The `cellPath` field is
// a RepeatedField<int> of `(direction << 12) | cellId` ints: just the start,
// every direction-change pivot, and the destination. We compute the path
// ourselves with pathfinder.ts (BFS on walkable cells).
// =============================================================================

export const MOVEMENT_PROTO = {
    classes: {
        MoveRequest: { friendly: "MapMoveRequest",            fallback: "isa" },
        Dispatcher:  { friendly: "Network.OutgoingDispatcher", fallback: "ecx" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        // First field (efim) stays at default null in observations.
        MoveRequest_mode:     { classKey: "MoveRequest", friendly: "mode",     fallback: "efio" },
        MoveRequest_cellPath: { classKey: "MoveRequest", friendly: "cellPath", fallback: "efir" },
        MoveRequest_flag1:    { classKey: "MoveRequest", friendly: "flag1",    fallback: "efit" },
        MoveRequest_mapId:    { classKey: "MoveRequest", friendly: "mapId",    fallback: "efiv" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        Dispatcher_send: { classKey: "Dispatcher", friendly: "sendOutgoing", fallback: "xby" },
    } as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedMovementProto {
    classes: Record<keyof typeof MOVEMENT_PROTO["classes"], string>;
    fields:  Record<keyof typeof MOVEMENT_PROTO["fields"],  string>;
    methods: Record<keyof typeof MOVEMENT_PROTO["methods"], string>;
}

// =============================================================================
// Map change flow — fast variant with dispatcher intercept:
//   1. setChangeMapIntercept(["jnr","isp"])  ← hook drops the client's auto-emits
//   2. moveToNewMap (ito)                    ← we send it
//      → server: mapTransitionAck (knw, diagnostic milestone)
//      → backend immediately forges and sends jnr + isp (instead of waiting
//        ~1.2s for the client's loading coroutine to do it)
//      → server: mapInfo (itx), then mapEventsList (kta, completion)
//   3. setChangeMapIntercept([])             ← release the hook
//
// The dispatcher hook is class-scoped: it drops any outgoing packet whose
// class name is in the block list, but lets through packets we send ourselves
// (tracked agent-side via a manual-send depth counter).
// =============================================================================

export const CHANGE_MAP_PROTO = {
    classes: {
        MoveToNewMap:       { friendly: "moveToNewMap",                fallback: "ito" },
        MapInfoRequest:     { friendly: "MapInformationsRequest",      fallback: "jnr" },
        MapEnteredNotif:    { friendly: "MapEnteredNotification",      fallback: "isp" },
        TransitionAck:      { friendly: "mapTransitionAck",            fallback: "knw" },
        MapEventsList:      { friendly: "mapEventsList",               fallback: "kta" },
        Dispatcher:         { friendly: "Network.OutgoingDispatcher",  fallback: "ecx" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        // moveToNewMap (ito) — first field is null header, second is mapId,
        // third is a bool we've only ever seen as false (likely "useTeleport").
        MoveToNewMap_mapId:    { classKey: "MoveToNewMap",    friendly: "mapId", fallback: "efqy" },
        MoveToNewMap_flag1:    { classKey: "MoveToNewMap",    friendly: "flag1", fallback: "efra" },

        // MapInformationsRequest (jnr) — null header, a long that's always 0
        // in observations (possibly fromCellId), then the target mapId as long.
        MapInfoRequest_flag1:  { classKey: "MapInfoRequest",  friendly: "flag1", fallback: "elbh" },
        MapInfoRequest_mapId:  { classKey: "MapInfoRequest",  friendly: "mapId", fallback: "elbj" },

        // MapEnteredNotification (isp) — two null headers, an int = 0, then mapId.
        MapEnteredNotif_flag1: { classKey: "MapEnteredNotif", friendly: "flag1", fallback: "eflj" },
        MapEnteredNotif_mapId: { classKey: "MapEnteredNotif", friendly: "mapId", fallback: "efll" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        Dispatcher_send: { classKey: "Dispatcher", friendly: "sendOutgoing", fallback: "xby" },
    } as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedChangeMapProto {
    classes: Record<keyof typeof CHANGE_MAP_PROTO["classes"], string>;
    fields:  Record<keyof typeof CHANGE_MAP_PROTO["fields"],  string>;
    methods: Record<keyof typeof CHANGE_MAP_PROTO["methods"], string>;
}

// =============================================================================
// Player state — runtime classes the PlayerStore reads at init to bootstrap
// the player snapshot (mapId, target cell, characterId). Updates after init
// will be WS-message-driven (next phase); no triggers live here anymore.
// =============================================================================

export const PLAYER_STATE_PROTO = {
    classes: {
        MovementController:     { friendly: "MovementController",      fallback: "dve" },
        LocalCharacter:         { friendly: "LocalCharacter",          fallback: "gic" },
        // WS-update trigger: server broadcasts every entity's movement —
        // one frame per move, even our own (filter by entityId === characterId).
        // Carries the cellPath we're about to follow → targetCellId + isMoving.
        MapEntityMovement:      { friendly: "mapEntityMovement",       fallback: "itv" },
        // WS-update trigger: client sends `itr` when our move ends.
        // Empty payload — used purely as a signal to clear cellPath / isMoving.
        MoveStop:               { friendly: "MoveStop",                fallback: "itr" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        MovementController_targetCellId: { classKey: "MovementController", friendly: "targetCellId", fallback: "dezz" },
        LocalCharacter_characterId:      { classKey: "LocalCharacter",     friendly: "characterId",  fallback: "<dsck>k__BackingField" },
        MapEntityMovement_entityId:      { classKey: "MapEntityMovement",  friendly: "entityId",     fallback: "efss" },
        MapEntityMovement_cellPath:      { classKey: "MapEntityMovement",  friendly: "cellPath",     fallback: "efsq" },
    } as Record<string, ProtoMemberSpec>,
    methods: {} as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedPlayerStateProto {
    classes: Record<keyof typeof PLAYER_STATE_PROTO["classes"], string>;
    fields:  Record<keyof typeof PLAYER_STATE_PROTO["fields"],  string>;
    methods: Record<keyof typeof PLAYER_STATE_PROTO["methods"], string>;
}

// =============================================================================
// Map state — what we track at the map level (mapId + entity list). Bootstrap
// flow: read MapRenderer.currentMapId → forge an isp(mapId) so the server
// re-broadcasts an itx → MapStateStore parses entities (entityId, cellId,
// name, level). After init, every natural itx (= every map change) keeps the
// store in sync. Updates of entity position during the map-stay are tracked
// independently via the itv handler in PlayerStore.
// =============================================================================

export const MAP_STATE_PROTO = {
    classes: {
        // For the initial mapId read.
        MapRenderer:            { friendly: "MapRenderer",             fallback: "MapRenderer" },
        // For triggering the bootstrap itx.
        MapEnteredNotification: { friendly: "MapEnteredNotification",  fallback: "isp" },
        Dispatcher:             { friendly: "Network.OutgoingDispatcher", fallback: "ecx" },
        // For matching the incoming itx + the entity-data deep chain.
        MapInfo:                { friendly: "mapInfo",                 fallback: "itx" },
        MapEntity:              { friendly: "MapEntity",               fallback: "khg" },
        EntityPosition:         { friendly: "EntityPosition",          fallback: "kjp" },
        EntityLook:             { friendly: "EntityLook",              fallback: "khe" },
        CharacterAttributes:    { friendly: "CharacterAttributes",     fallback: "kgl" },
        // kgl.epsa is polymorphic — CharacterCard is the player-variant
        // (kgb). The other variants live under their own classes below.
        CharacterCard:          { friendly: "CharacterCard",           fallback: "kgb" },
        CharacterProgression:   { friendly: "CharacterProgression",    fallback: "kfy" },
        LevelInfo:              { friendly: "LevelInfo",               fallback: "kli" },
        // Monster group variant of kgl.epsa.
        MonsterGroupCard:       { friendly: "MonsterGroupCard",        fallback: "kgg" },
        MonsterGroupContent:    { friendly: "MonsterGroupContent",     fallback: "kcj" },
        MonsterEntry:           { friendly: "MonsterEntry",            fallback: "kjs" },
        // NPC variant of kgl.epsa.
        NpcCard:                { friendly: "NpcCard",                 fallback: "kgj" },
        // For the interactables join (eftq + eftt) into MapState.interactables.
        InteractiveElement:     { friendly: "InteractiveElement",      fallback: "kne" },
        InteractiveElementSkill:{ friendly: "InteractiveElementSkill", fallback: "knc" },
        StatedElement:          { friendly: "StatedElement",           fallback: "kdb" },
        // Incremental updates after the initial itx — patch the in-memory
        // interactable instead of waiting for the next itx broadcast.
        StatedElementUpdate:    { friendly: "StatedElementUpdate",     fallback: "ieu" },
        InteractiveElementUpdated: { friendly: "InteractiveElementUpdated", fallback: "iet" },
        // Entity-list patches between itx broadcasts.
        NewPlayerOnMap:         { friendly: "newPlayerOnMap",          fallback: "irx" },
        PlayerLeaveMap:         { friendly: "playerLeaveMap",          fallback: "jvn" },
        MapEntityMovement:      { friendly: "mapEntityMovement",       fallback: "itv" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        MapRenderer_currentMapId:        { classKey: "MapRenderer",            friendly: "currentMapId", fallback: "czav" },
        MapEnteredNotification_flag1:    { classKey: "MapEnteredNotification", friendly: "flag1",        fallback: "eflj" },
        MapEnteredNotification_mapId:    { classKey: "MapEnteredNotification", friendly: "mapId",        fallback: "efll" },
        MapInfo_mapId:                   { classKey: "MapInfo",                friendly: "mapId",        fallback: "efti" },
        MapInfo_entities:                { classKey: "MapInfo",                friendly: "entities",     fallback: "eftd" },
        MapEntity_entityId:              { classKey: "MapEntity",              friendly: "entityId",     fallback: "epww" },
        MapEntity_position:              { classKey: "MapEntity",              friendly: "position",     fallback: "epxa" },
        MapEntity_look:                  { classKey: "MapEntity",              friendly: "look",         fallback: "epxc" },
        EntityPosition_cellId:           { classKey: "EntityPosition",         friendly: "cellId",       fallback: "eqqq" },
        EntityLook_characterAttributes:  { classKey: "EntityLook",             friendly: "characterAttributes", fallback: "epwr" },
        CharacterAttributes_characterCard: { classKey: "CharacterAttributes",  friendly: "characterCard", fallback: "epsa" },
        // Enum discriminator for the variant under .characterCard:
        // 7 = player (kgb), 3 = monsterGroup (kgg), 5 = npc (kgj).
        CharacterAttributes_kind:        { classKey: "CharacterAttributes",    friendly: "kind",         fallback: "epsb" },
        CharacterCard_name:              { classKey: "CharacterCard",          friendly: "name",         fallback: "eppb" },
        CharacterCard_progression:       { classKey: "CharacterCard",          friendly: "progression",  fallback: "eppe" },
        CharacterProgression_levelInfo:  { classKey: "CharacterProgression",   friendly: "levelInfo",    fallback: "epor" },
        LevelInfo_level:                 { classKey: "LevelInfo",              friendly: "level",        fallback: "ereh" },
        // Monster group fields (kgg → kcj → kjs).
        MonsterGroupCard_content:        { classKey: "MonsterGroupCard",       friendly: "content",      fallback: "epqm" },
        MonsterGroupContent_leader:      { classKey: "MonsterGroupContent",    friendly: "leader",       fallback: "eood" },
        MonsterGroupContent_members:     { classKey: "MonsterGroupContent",    friendly: "members",      fallback: "eoob" },
        MonsterEntry_monsterId:          { classKey: "MonsterEntry",           friendly: "monsterId",    fallback: "eqrp" },
        MonsterEntry_level:              { classKey: "MonsterEntry",           friendly: "level",        fallback: "eqrt" },
        MonsterEntry_grade:              { classKey: "MonsterEntry",           friendly: "grade",        fallback: "eqrn" },
        // NPC card field.
        NpcCard_npcId:                   { classKey: "NpcCard",                friendly: "npcId",        fallback: "epro" },
        // Interactables join fields — itx.eftt (interactives) ↔ itx.eftq
        // (statedElements) by elementId. enabled/disabled skills carry the
        // skillId + skillInstanceUid the bot needs to invoke an action.
        MapInfo_interactives:            { classKey: "MapInfo",                friendly: "interactives", fallback: "eftt" },
        MapInfo_statedElements:          { classKey: "MapInfo",                friendly: "statedElements", fallback: "eftq" },
        InteractiveElement_elementId:        { classKey: "InteractiveElement",     friendly: "elementId",        fallback: "erqk" },
        InteractiveElement_interactiveTypeId:{ classKey: "InteractiveElement",     friendly: "interactiveTypeId",fallback: "erqx" },
        InteractiveElement_enabledSkills:    { classKey: "InteractiveElement",     friendly: "enabledSkills",    fallback: "erqn" },
        InteractiveElement_disabledSkills:   { classKey: "InteractiveElement",     friendly: "disabledSkills",   fallback: "erqv" },
        InteractiveElementSkill_skillId:         { classKey: "InteractiveElementSkill", friendly: "skillId",          fallback: "erpy" },
        InteractiveElementSkill_skillInstanceUid:{ classKey: "InteractiveElementSkill", friendly: "skillInstanceUid", fallback: "erqd" },
        StatedElement_state:        { classKey: "StatedElement", friendly: "state",        fallback: "eoun" },
        StatedElement_onCurrentMap: { classKey: "StatedElement", friendly: "isVisible", fallback: "eoup" },
        StatedElement_elementId:    { classKey: "StatedElement", friendly: "elementId",    fallback: "eour" },
        StatedElement_cell:         { classKey: "StatedElement", friendly: "cell",         fallback: "eout" },
        // ieu / iet wrap a single payload of the underlying type (kdb / kne).
        StatedElementUpdate_payload:    { classKey: "StatedElementUpdate",    friendly: "statedElement", fallback: "econ" },
        InteractiveElementUpdated_payload: { classKey: "InteractiveElementUpdated", friendly: "interactive",  fallback: "ecoj" },
        // Entity-list patch fields.
        NewPlayerOnMap_entities:        { classKey: "NewPlayerOnMap",    friendly: "entities", fallback: "efig" },
        PlayerLeaveMap_entityId:        { classKey: "PlayerLeaveMap",    friendly: "entityId", fallback: "elbt" },
        MapEntityMovement_entityId:     { classKey: "MapEntityMovement", friendly: "entityId", fallback: "efss" },
        MapEntityMovement_cellPath:     { classKey: "MapEntityMovement", friendly: "cellPath", fallback: "efsq" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        Dispatcher_send: { classKey: "Dispatcher", friendly: "sendOutgoing", fallback: "xby" },
    } as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedMapStateProto {
    classes: Record<keyof typeof MAP_STATE_PROTO["classes"], string>;
    fields:  Record<keyof typeof MAP_STATE_PROTO["fields"],  string>;
    methods: Record<keyof typeof MAP_STATE_PROTO["methods"], string>;
}

// =============================================================================
// Houses / enclos on the map (itx.eftn) — one entry per house plot visible
// from the current map. Each entry carries the house's owner card chain:
//   itx.eftn[i]                                 = MapHouseEntry (kav)
//   MapHouseEntry.ownership                     = HouseOwnership (kar)
//   HouseOwnership.accessRights[j]              = HouseAccessRight (kjo)
//   HouseAccessRight.owner                      = PlayerCard (kde)
//   PlayerCard.name                             = "Le-conquerantxxx"  (string)
//   PlayerCard.playerId                         = "8685"              (string-coded id)
// The intermediate classes are surfaced here so the labels engine captures
// each step's structural fingerprint — even though we don't read the nested
// payloads from code yet, future obf rotations will follow the renames.
// =============================================================================

export const HOUSE_PROTO = {
    classes: {
        MapInfo:          { friendly: "mapInfo",          fallback: "itx" },
        MapHouseEntry:    { friendly: "MapHouseEntry",    fallback: "kav" },
        HouseOwnership:   { friendly: "HouseOwnership",   fallback: "kar" },
        HouseAccessRight: { friendly: "HouseAccessRight", fallback: "kjo" },
        PlayerCard:       { friendly: "PlayerCard",       fallback: "kde" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        MapInfo_houses:                       { classKey: "MapInfo",          friendly: "houses",            fallback: "eftn" },
        // kav.eobr = unique houseId (high-cardinality int, e.g. 461378 /
        // 461383). kav.eobp is in [0, 559] but is NOT the door cellId
        // (verified in-game) — semantics still unknown, kept unlabeled.
        MapHouseEntry_houseId:                { classKey: "MapHouseEntry",    friendly: "houseId",           fallback: "eobr" },
        MapHouseEntry_ownership:              { classKey: "MapHouseEntry",    friendly: "ownership",         fallback: "eobw" },
        HouseOwnership_rights:                { classKey: "HouseOwnership",   friendly: "accessRights",      fallback: "eoar" },
        // kar.eoau = list of interactive elementIds linked to this house
        // (typically just the door). The single elementId here also appears
        // in itx.eftt with interactiveTypeId 300 = Maison. Joining lets us
        // recover cellId for any eftt entry of typeId 300 without the static
        // dump: lookup `elementId in eftn[k].eoau` → cell = eftn[k].eobp.
        HouseOwnership_elementIds:            { classKey: "HouseOwnership",   friendly: "elementIds",        fallback: "eoau" },
        HouseAccessRight_owner:               { classKey: "HouseAccessRight", friendly: "owner",             fallback: "eqpq" },
        // kjo.eqpt = sale price in kamas (long; observed 39_999_999 /
        // 38_000_000 / 0 — typical Dofus house pricing).
        HouseAccessRight_price:               { classKey: "HouseAccessRight", friendly: "price",             fallback: "eqpt" },
        PlayerCard_name:                      { classKey: "PlayerCard",       friendly: "name",              fallback: "eovl" },
        PlayerCard_playerId:                  { classKey: "PlayerCard",       friendly: "playerId",          fallback: "eovn" },
    } as Record<string, ProtoMemberSpec>,
    methods: {} as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedHouseProto {
    classes: Record<keyof typeof HOUSE_PROTO["classes"], string>;
    fields:  Record<keyof typeof HOUSE_PROTO["fields"],  string>;
    methods: Record<keyof typeof HOUSE_PROTO["methods"], string>;
}

// =============================================================================
// World pathfinding (auto-travel) — the in-game "click a map on the worldmap
// and the character walks there autonomously" feature.
//
//   AutoTravelManager (elj)   → high-level service; entry point bapc()
//      .pathfinder (dkdu) → WorldPathfinder (ell)
//   WorldPathfinder (ell)     → wraps one A* worker; owns last result
//      .worker (dked)     → WorldPathfindingWorker (fpc)
//      .startVertex (dkea), .destMapId (dkeb), .state (dkec)
//   WorldPathfindingWorker (fpc) → A* algorithm itself
//      .resultEdges (dpln) → List<Edge> = THE PATH
//      .findPath (bguk)    → start the A*: (Vertex from, Vertex to, cb, bool)
//      .deliverResult (nwf)→ internal "publish path" — ideal hook target
//
// Edge / Vertex / Transition / PathFindingData have clear-name types from
// Core.PathFinding.WorldPathfinding so don't need labels.
// =============================================================================

export const WORLD_PATHFINDING_PROTO = {
    classes: {
        AutoTravelManager:        { friendly: "AutoTravelManager",         fallback: "elj" },
        WorldPathfinder:          { friendly: "WorldPathfinder",           fallback: "ell" },
        WorldPathfindingWorker:   { friendly: "WorldPathfindingWorker",    fallback: "fpc" },
    } as Record<string, ProtoClassSpec>,
    fields: {
        // AutoTravelManager.dkds : ere (the pathfinder runtime context — passed
        // as the 4th argument to WorldPathfinder.computePath)
        AutoTravelManager_pathfinderContext: { classKey: "AutoTravelManager",      friendly: "pathfinderContext",  fallback: "dkds" },
        // WorldPathfinder.dked : fpc (the live A* worker)
        WorldPathfinder_worker:              { classKey: "WorldPathfinder",        friendly: "worker",      fallback: "dked" },
        // WorldPathfinder.dkea : Vertex (start)
        WorldPathfinder_startVertex:         { classKey: "WorldPathfinder",        friendly: "startVertex", fallback: "dkea" },
        // WorldPathfinder.dkeb : long (destination mapId)
        WorldPathfinder_destMapId:           { classKey: "WorldPathfinder",        friendly: "destMapId",   fallback: "dkeb" },
        // WorldPathfinder.dkec : int (state/phase)
        WorldPathfinder_state:               { classKey: "WorldPathfinder",        friendly: "state",       fallback: "dkec" },
        // WorldPathfindingWorker.dpln : List<Edge> (the result path)
        WorldPathfindingWorker_resultEdges:  { classKey: "WorldPathfindingWorker", friendly: "resultEdges", fallback: "dpln" },
        // WorldPathfinder.dkdy : static PathFindingData (the world graph asset).
        // Read by extractWorldGraph; populated lazily by `init` (bapg) the first
        // time anything triggers the auto-travel pipeline.
        WorldPathfinder_pathFindingData:     { classKey: "WorldPathfinder",        friendly: "pathFindingData", fallback: "dkdy" },
    } as Record<string, ProtoMemberSpec>,
    methods: {
        /** AutoTravelManager.bapc(long destMapId, Action<List<Edge>,bool> cb, bool flag) → void.
         *  Public entry: computes path AND kicks off movement via its own lambda
         *  (which calls computePath internally then triggers walking). Hooked
         *  observe-only for diag — we don't invoke it. */
        AutoTravelManager_startAutoTravel:    { classKey: "AutoTravelManager",      friendly: "startAutoTravel", fallback: "bapc" },
        /** WorldPathfinder.bapj(long destMapId, long srcMapId, long currentCellId,
         *  ere, Action<List<Edge>,bool> cb, bool flag) → void.
         *  PURE pathfinder — the method `bapc` calls internally. Publishes the
         *  result to fpc.resultEdges before invoking cb. Invoking with cb=NULL
         *  gives us the path without triggering movement. */
        WorldPathfinder_computePath:          { classKey: "WorldPathfinder",        friendly: "computePath",     fallback: "bapj" },
        /** WorldPathfindingWorker.nwf(List<Edge>, bool) → void.
         *  Internal "publish result" — fires once per completed computation.
         *  Hooked to detect "fresh" path captures during active invokes. */
        WorldPathfindingWorker_deliverResult: { classKey: "WorldPathfindingWorker", friendly: "deliverResult",   fallback: "nwf" },
        /** WorldPathfinder.bapg() → UniTask. Async Init that loads the
         *  PathFindingData ScriptableObject via Addressables and stores it in
         *  the static `dkdy`. Called by triggerPathFindingDataLoad. */
        WorldPathfinder_init:                 { classKey: "WorldPathfinder",        friendly: "init",            fallback: "bapg" },
        /** WorldPathfindingWorker.bgul(PathFindingData) → void.
         *  Static setter — registers the loaded PathFindingData with fpc's
         *  static `dplc`. One of two redundant setters; call both for safety. */
        WorldPathfindingWorker_registerData1: { classKey: "WorldPathfindingWorker", friendly: "registerData1",   fallback: "bgul" },
        /** WorldPathfindingWorker.gmj(PathFindingData) → void.
         *  Sibling of bgul — same purpose, same target field. */
        WorldPathfindingWorker_registerData2: { classKey: "WorldPathfindingWorker", friendly: "registerData2",   fallback: "gmj" },
    } as Record<string, ProtoMemberSpec>,
} as const;

export interface ResolvedWorldPathfindingProto {
    classes: Record<keyof typeof WORLD_PATHFINDING_PROTO["classes"], string>;
    fields:  Record<keyof typeof WORLD_PATHFINDING_PROTO["fields"],  string>;
    methods: Record<keyof typeof WORLD_PATHFINDING_PROTO["methods"], string>;
}
