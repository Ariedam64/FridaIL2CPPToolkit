// Trade Center (HDV) actions — outgoing packet senders. The agent forges and
// dispatches each request; response handling is delegated to the network
// monitor's frame store on the backend side (see TradeCenterActions in
// app/plugins/dofus/lib/), which captures every incoming packet via
// fzn.Decode and is reliable across builds.
//
// Per-class MergeFrom hooks were tried first but didn't fire on this build,
// while the network monitor's hook does — so we read responses from there.
//
// Obfuscated names are NOT in this file. The caller passes a resolved
// `TradeCenterProto` object holding the current obf names for every class /
// field / method we touch. This object is built backend-side from the
// LabelStore (see app/plugins/dofus/lib/protocol.ts).
//
// IMPORTANT: the `TradeCenterProto` interface below must mirror the
// `ResolvedTradeCenterProto` shape on the plugin backend side. Both sides are
// checked independently by tsc — keep them in sync.

import { inVm, getLiveInstance, safeInt, readListItems, readListSize, findClass } from "./_runtime";

// =============================================================================
// Resolved protocol — class/field/method obf names provided per call.
// =============================================================================

export interface TradeCenterProto {
    classes: {
        OpenRequest:      string;
        OpenResponse:     string;
        SelectRequest:    string;
        SelectResponse:   string;
        DetailRequest:    string;
        DetailResponse:   string;
        Offer:            string;
        BuyRequest:       string;
        TransactionState: string;
        Dispatcher:       string;
        BidHouseService:  string;
    };
    fields: {
        OpenRequest_field0:          string;
        OpenRequest_flag1:           string;
        OpenRequest_interactionId:   string;
        OpenRequest_extra:           string;
        OpenRequest_flag2:           string;
        OpenResponse_objects:        string;
        OpenResponse_timestamp:      string;
        SelectRequest_typeId:        string;
        SelectRequest_active:        string;
        SelectResponse_typeId:       string;
        SelectResponse_itemIds:      string;
        DetailRequest_show:          string;
        DetailRequest_objectId:      string;
        DetailResponse_object:       string;
        DetailResponse_typeId:       string;
        DetailResponse_itemId:       string;
        Offer_typeId:                string;
        Offer_itemId:                string;
        Offer_auctionId:             string;
        Offer_stats:                 string;
        Offer_prices:                string;
        BuyRequest_quantity:         string;
        BuyRequest_price:            string;
        BuyRequest_auctionId:        string;
        TransactionState_auctionId:  string;
        TransactionState_success:    string;
        BidHouseService_typeIdsList: string;
        BidHouseService_searchCache: string;
    };
    methods: {
        Dispatcher_send:        string;
        BidHouseService_search: string;
    };
}

// =============================================================================
// Public API — every action returns immediately after dispatching the packet.
// =============================================================================

export interface SendResult {
    ok: boolean;
    reason?: string;
}

function buildAndSend(
    proto: TradeCenterProto,
    classKey: keyof TradeCenterProto["classes"],
    populate: (req: any) => void,
): SendResult {
    const reqK = findClass(proto.classes[classKey]);
    if (!reqK) return { ok: false, reason: `${proto.classes[classKey]} class not found` };
    const dispatcher = getLiveInstance(proto.classes.Dispatcher);
    if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

    let req: any;
    try {
        req = (reqK as any).new();
        req.method(".ctor").overload().invoke();
        populate(req);
    } catch (e) {
        return { ok: false, reason: `${proto.classes[classKey]} build failed: ${String(e).slice(0, 200)}` };
    }
    try {
        (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
    }
}

/** Forge an OpenRequest and dispatch it. The third field on the wire
 *  (`ecos` = `interactionId`) carries the elementId of the trade-center NPC
 *  on the current map. The fourth field (`ecou` = `extra`) is an additional
 *  id we observed but haven't fully decoded yet. */
export function sendOpenTradeCenter(
    proto: TradeCenterProto,
    interactionId: number,
    extra: number = 0,
): Promise<SendResult> {
    return inVm(() => buildAndSend(proto, "OpenRequest", (req) => {
        // field0 stays at its default (null/0). flag1 + flag2 default to 0.
        req.field(proto.fields.OpenRequest_flag1).value = 0;
        req.field(proto.fields.OpenRequest_interactionId).value = interactionId;
        req.field(proto.fields.OpenRequest_extra).value = extra;
        req.field(proto.fields.OpenRequest_flag2).value = 0;
    }));
}

/** Send a SelectRequest to filter the open trade center by category typeId.
 *  NOTE: this is purely a UI-side filter. The server happily serves any item
 *  via DetailRequest without a prior selectCategory — Open → Fetch → Buy is
 *  sufficient. Kept for completeness if someone wants to mirror the UI flow. */
export function sendSelectCategory(
    proto: TradeCenterProto,
    typeId: number,
): Promise<SendResult> {
    return inVm(() => buildAndSend(proto, "SelectRequest", (req) => {
        req.field(proto.fields.SelectRequest_typeId).value = typeId;
        req.field(proto.fields.SelectRequest_active).value = true;
    }));
}

/** Send the two DetailRequests the UI sends (show=false then show=true).
 *  Sending only show=true makes the server drop it as a no-op when an item
 *  is already implicitly followed. */
export function sendFetchItemDetail(
    proto: TradeCenterProto,
    itemId: number,
): Promise<SendResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.DetailRequest);
        if (!reqK) return { ok: false, reason: `${proto.classes.DetailRequest} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };
        try {
            const r1 = (reqK as any).new(); r1.method(".ctor").overload().invoke();
            r1.field(proto.fields.DetailRequest_show).value = false;
            r1.field(proto.fields.DetailRequest_objectId).value = itemId;
            const r2 = (reqK as any).new(); r2.method(".ctor").overload().invoke();
            r2.field(proto.fields.DetailRequest_show).value = true;
            r2.field(proto.fields.DetailRequest_objectId).value = itemId;
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(r1);
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(r2);
            return { ok: true } as SendResult;
        } catch (e) {
            return { ok: false, reason: `DetailRequest send failed: ${String(e).slice(0, 200)}` };
        }
    });
}

/** Send a BuyRequest. The server validates `price` exactly against the
 *  current listing — pass the value from the matching tier in the offer's
 *  prices array. */
export function sendBuyOffer(
    proto: TradeCenterProto,
    auctionId: number,
    quantity: number,
    price: number,
): Promise<SendResult> {
    return inVm(() => buildAndSend(proto, "BuyRequest", (req) => {
        req.field(proto.fields.BuyRequest_quantity).value = quantity;
        req.field(proto.fields.BuyRequest_price).value = price;
        req.field(proto.fields.BuyRequest_auctionId).value = auctionId;
    }));
}

// =============================================================================
// searchByTypeIds — different mechanism, kept here. Mutates the BidHouseService's
// existing typeIdsList in place (Frida can't resolve generic List<UInt32> by
// name) and reads the cache after the round-trip. Doesn't rely on any hook.
// =============================================================================

const SEARCH_CACHE_TYPEID      = "dkqr";
const SEARCH_CACHE_ITEMS_LIST  = "dkqq";
const SEARCH_ITEM_ID_FIELDS    = ["dkly", "dkqs", "dkqt", "id"] as const;

export interface TradeCenterSearchEntry {
    typeId: number;
    itemIds: number[];
}

export interface TradeCenterSearchResult {
    ok: boolean;
    entries: TradeCenterSearchEntry[];
    reason?: string;
}

export function searchByTypeIds(
    proto: TradeCenterProto,
    typeIds: number[],
    waitMs: number = 800,
): Promise<TradeCenterSearchResult> {
    return inVm(() => new Promise<TradeCenterSearchResult>((resolve) => {
        const svc = getLiveInstance(proto.classes.BidHouseService);
        if (!svc) return resolve({ ok: false, entries: [], reason: `no live ${proto.classes.BidHouseService} instance` });

        try {
            const list = (svc as any).field(proto.fields.BidHouseService_typeIdsList).value;
            if (!list) return resolve({ ok: false, entries: [], reason: `${proto.classes.BidHouseService}.${proto.fields.BidHouseService_typeIdsList} is null (HDV never opened?)` });
            try { list.method("Clear").invoke(); } catch {}
            for (const tid of typeIds) {
                try { list.method("Add").invoke(tid >>> 0); } catch {}
            }
            (svc as any).method(proto.methods.BidHouseService_search).invoke(list);
        } catch (e) {
            return resolve({ ok: false, entries: [], reason: `search setup/invoke failed: ${String(e).slice(0, 200)}` });
        }

        setTimeout(() => {
            try {
                const cache = (svc as any).field(proto.fields.BidHouseService_searchCache).value;
                if (!cache) return resolve({ ok: false, entries: [], reason: `${proto.classes.BidHouseService}.${proto.fields.BidHouseService_searchCache} is null` });
                const items = readListItems(cache);
                const sz = readListSize(cache);
                if (!items) return resolve({ ok: false, entries: [], reason: "no _items on search cache" });
                const wanted = new Set(typeIds);
                const out: TradeCenterSearchEntry[] = [];
                for (let i = 0; i < sz; i++) {
                    let entry: any;
                    try { entry = items.get(i); } catch { continue; }
                    if (!entry) continue;
                    const typeId = safeInt(entry, SEARCH_CACHE_TYPEID);
                    if (!wanted.has(typeId)) continue;
                    const itemIds: number[] = [];
                    try {
                        const inner = entry.field(SEARCH_CACHE_ITEMS_LIST).value;
                        const innerItems = readListItems(inner);
                        const innerSz = readListSize(inner);
                        if (innerItems) {
                            for (let j = 0; j < innerSz; j++) {
                                let itemEntry: any;
                                try { itemEntry = innerItems.get(j); } catch { continue; }
                                if (!itemEntry) continue;
                                let id = 0;
                                for (const fn of SEARCH_ITEM_ID_FIELDS) {
                                    try { const v = itemEntry.field(fn).value; if (typeof v === "number" && v > 0) { id = Number(v); break; } } catch {}
                                }
                                if (id > 0) itemIds.push(id);
                            }
                        }
                    } catch {}
                    out.push({ typeId, itemIds });
                }
                resolve({ ok: true, entries: out });
            } catch (e) {
                resolve({ ok: false, entries: [], reason: `read search cache failed: ${String(e).slice(0, 200)}` });
            }
        }, Math.max(50, waitMs));
    }));
}
