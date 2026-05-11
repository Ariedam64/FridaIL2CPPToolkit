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
        StatedElement_onCurrentMap:    { classKey: "StatedElement", friendly: "onCurrentMap",     fallback: "eoup" },
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
        CharacterCard:          { friendly: "CharacterCard",           fallback: "kgb" },
        CharacterProgression:   { friendly: "CharacterProgression",    fallback: "kfy" },
        LevelInfo:              { friendly: "LevelInfo",               fallback: "kli" },
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
        CharacterCard_name:              { classKey: "CharacterCard",          friendly: "name",         fallback: "eppb" },
        CharacterCard_progression:       { classKey: "CharacterCard",          friendly: "progression",  fallback: "eppe" },
        CharacterProgression_levelInfo:  { classKey: "CharacterProgression",   friendly: "levelInfo",    fallback: "epor" },
        LevelInfo_level:                 { classKey: "LevelInfo",              friendly: "level",        fallback: "ereh" },
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
