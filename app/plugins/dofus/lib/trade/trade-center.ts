// Backend façade for the Dofus Trade Center actions. Each method:
//   1. Snapshots the latest frame id (so we don't race with prior traffic)
//   2. Resolves the protocol spec → current obf names via the LabelStore
//   3. Sends the outgoing packet via the agent (RPC just dispatches, no hook)
//   4. Awaits the matching response on the network monitor's FrameStore
//   5. Parses the captured frame fields and returns a typed result
//
// We use the FrameStore (capturing every packet via fzn.Decode) rather than
// installing per-class MergeFrom hooks: those don't fire reliably on this
// build, while the network monitor's hook is universally exercised.

import type { LabelStore } from "../../../../backend/core/labels";
import type { RpcClient } from "../../../../backend/core/types";
import type { FrameStore } from "../../../../backend/core/network/frame-store";
import type { NetworkFrame } from "../../../../backend/core/network/types";
import { TRADE_CENTER_PROTO, type ResolvedTradeCenterProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";
import {
    waitForFrame, latestFrameId,
    findField, intFromField, boolFromField, arrayLength, intArrayFromField,
} from "../frame-await";

export interface TradeCenterOffer {
    auctionId: number;
    typeId: number;
    itemId: number;
    statsCount: number;
    /** Prices indexed by quantity tier (1u / 10u / 100u / 1000u). */
    prices: number[];
}

export interface OpenTradeCenterResult {
    ok: boolean;
    itemCount?: number;
    serverTimestamp?: number;
    reason?: string;
}

export interface SelectCategoryResult {
    ok: boolean;
    typeId?: number;
    itemIds?: number[];
    reason?: string;
}

export interface FetchItemDetailResult {
    ok: boolean;
    itemId: number;
    offers?: TradeCenterOffer[];
    reason?: string;
}

export interface BuyOfferResult {
    ok: boolean;
    auctionId: number;
    /** True if the server confirmed the buy, false if it rejected. Undefined on timeout. */
    success?: boolean;
    reason?: string;
}

export interface BuyNowResult {
    ok: boolean;
    success?: boolean;
    /** auctionId of the offer we picked (cheapest at the requested qty tier). */
    auctionId?: number;
    /** Total kamas paid (or that would have been paid on success). */
    paid?: number;
    /** Number of offers seen for this item. */
    offerCount?: number;
    reason?: string;
}

export interface BuyNowOpts {
    /** Default 522694 — elementId of the BidHouse Resources NPC observed
     *  during the live capture session. Override per session/map. */
    interactionId?: number;
    /** Default 8746 — second iev field, observed alongside interactionId in
     *  the same capture. Semantics not fully decoded. */
    extra?: number;
    /** Refuse to buy if the cheapest tier price exceeds this cap. */
    maxPrice?: number;
}

const QTY_TIER_INDEX: Record<number, number> = { 1: 0, 10: 1, 100: 2, 1000: 3 };

export interface TradeCenterSearchEntry {
    typeId: number;
    itemIds: number[];
}

export interface TradeCenterSearchResult {
    ok: boolean;
    entries: TradeCenterSearchEntry[];
    reason?: string;
}

interface SendResult { ok: boolean; reason?: string; }

export class TradeCenterActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
        private readonly frames: FrameStore,
    ) {}

    private proto(): ResolvedTradeCenterProto {
        return resolveProto(this.labels, TRADE_CENTER_PROTO) as ResolvedTradeCenterProto;
    }

    /** Open the trade center owned by the interactive at `interactionId`
     *  (the elementId on the current map). `extra` is an additional id we
     *  haven't fully decoded yet. */
    async openTradeCenter(interactionId: number, extra: number = 0, waitMs: number = 1500): Promise<OpenTradeCenterResult> {
        const proto = this.proto();
        const sinceId = latestFrameId(this.frames);
        const send = await this.rpc.call<SendResult>("sendOpenTradeCenter", [proto, interactionId, extra]);
        if (!send.ok) return { ok: false, reason: send.reason };

        const frame = await waitForFrame(
            this.frames,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.OpenResponse,
            waitMs, sinceId,
        );
        if (!frame) return { ok: false, reason: "no OpenResponse within timeout" };

        return {
            ok: true,
            itemCount: arrayLength(findField(frame.fields, proto.fields.OpenResponse_objects)) ?? undefined,
            serverTimestamp: intFromField(findField(frame.fields, proto.fields.OpenResponse_timestamp)) ?? undefined,
        };
    }

    async selectCategory(typeId: number, waitMs: number = 1500): Promise<SelectCategoryResult> {
        const proto = this.proto();
        const sinceId = latestFrameId(this.frames);
        const send = await this.rpc.call<SendResult>("sendSelectCategory", [proto, typeId]);
        if (!send.ok) return { ok: false, reason: send.reason };

        const frame = await waitForFrame(
            this.frames,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.SelectResponse
                && intFromField(findField(f.fields, proto.fields.SelectResponse_typeId)) === typeId,
            waitMs, sinceId,
        );
        if (!frame) return { ok: false, reason: "no SelectResponse within timeout" };

        return {
            ok: true,
            typeId,
            itemIds: intArrayFromField(findField(frame.fields, proto.fields.SelectResponse_itemIds)),
        };
    }

    async fetchItemDetail(itemId: number, waitMs: number = 1500): Promise<FetchItemDetailResult> {
        const proto = this.proto();
        const sinceId = latestFrameId(this.frames);
        const send = await this.rpc.call<SendResult>("sendFetchItemDetail", [proto, itemId]);
        if (!send.ok) return { ok: false, itemId, reason: send.reason };

        const isMatch = (f: NetworkFrame): boolean =>
            f.direction === "in"
            && f.typeKey.className === proto.classes.DetailResponse
            && intFromField(findField(f.fields, proto.fields.DetailResponse_itemId)) === itemId;
        const offerCount = (f: NetworkFrame): number =>
            arrayLength(findField(f.fields, proto.fields.DetailResponse_object)) ?? 0;

        // The UI sends two DetailRequests (show=false then show=true). The
        // server sometimes replies with two DetailResponses — the first one
        // empty (acks the unfollow) and the second carrying the real offers.
        // Wait for the first match, and if it's empty, briefly wait for a
        // non-empty one before resolving.
        const first = await waitForFrame(this.frames, isMatch, waitMs, sinceId);
        if (!first) return { ok: false, itemId, reason: "no DetailResponse within timeout" };

        if (offerCount(first) > 0) {
            return { ok: true, itemId, offers: this.parseOffers(first, proto) };
        }
        const second = await waitForFrame(
            this.frames,
            (f) => isMatch(f) && offerCount(f) > 0,
            300, first.id,
        );
        const winner = second ?? first;
        return { ok: true, itemId, offers: this.parseOffers(winner, proto) };
    }

    /** Buy `quantity` units of `auctionId` at `price` total. The server
     *  validates `price` exactly against its current listing — pass the
     *  matching tier from `TradeCenterOffer.prices`. */
    async buyOffer(auctionId: number, quantity: number, price: number, waitMs: number = 2500): Promise<BuyOfferResult> {
        const proto = this.proto();
        const sinceId = latestFrameId(this.frames);
        const send = await this.rpc.call<SendResult>("sendBuyOffer", [proto, auctionId, quantity, price]);
        if (!send.ok) return { ok: false, auctionId, reason: send.reason };

        const frame = await waitForFrame(
            this.frames,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.TransactionState
                && intFromField(findField(f.fields, proto.fields.TransactionState_auctionId)) === auctionId,
            waitMs, sinceId,
        );
        if (!frame) return { ok: false, auctionId, reason: "no TransactionState within timeout" };

        return {
            ok: true,
            auctionId,
            success: boolFromField(findField(frame.fields, proto.fields.TransactionState_success)) ?? undefined,
        };
    }

    /** One-shot: open HDV, fetch item, buy the cheapest offer at the
     *  requested quantity tier. Tolerates "open already done" (skips that
     *  step's timeout silently). */
    async buyNow(itemId: number, quantity: number, opts: BuyNowOpts = {}): Promise<BuyNowResult> {
        const tier = QTY_TIER_INDEX[quantity];
        if (tier === undefined) {
            return { ok: false, reason: `quantity must be 1, 10, 100 or 1000 (got ${quantity})` };
        }

        const interactionId = opts.interactionId ?? 522694;
        const extra = opts.extra ?? 8746;

        // Step 1: open. Failure / timeout is non-fatal — server doesn't
        // re-respond to a redundant open while the HDV is already open.
        await this.openTradeCenter(interactionId, extra, 1500);

        // Step 2: fetch offers.
        const fetched = await this.fetchItemDetail(itemId, 1500);
        if (!fetched.ok) return { ok: false, reason: `fetch failed: ${fetched.reason}` };
        const offers = fetched.offers ?? [];
        if (offers.length === 0) return { ok: false, offerCount: 0, reason: "no offers for this item" };

        // Step 3: pick the cheapest offer at the requested tier.
        let best: { auctionId: number; price: number } | null = null;
        for (const o of offers) {
            const p = o.prices[tier];
            if (typeof p !== "number" || p <= 0) continue;
            if (!best || p < best.price) best = { auctionId: o.auctionId, price: p };
        }
        if (!best) {
            return { ok: false, offerCount: offers.length, reason: `no offer with a price at tier ${quantity}` };
        }
        if (opts.maxPrice !== undefined && best.price > opts.maxPrice) {
            return {
                ok: false, auctionId: best.auctionId, paid: best.price, offerCount: offers.length,
                reason: `cheapest price ${best.price} exceeds maxPrice ${opts.maxPrice}`,
            };
        }

        // Step 4: buy.
        const buy = await this.buyOffer(best.auctionId, quantity, best.price);
        return {
            ok: buy.ok,
            success: buy.success,
            auctionId: best.auctionId,
            paid: best.price,
            offerCount: offers.length,
            reason: buy.reason,
        };
    }

    searchByTypeIds(typeIds: number[], waitMs?: number): Promise<TradeCenterSearchResult> {
        return this.rpc.call<TradeCenterSearchResult>("searchByTypeIds", [this.proto(), typeIds, waitMs]);
    }

    private parseOffers(frame: NetworkFrame, proto: ResolvedTradeCenterProto): TradeCenterOffer[] {
        const offersField = findField(frame.fields, proto.fields.DetailResponse_object);
        if (!offersField?.children) return [];
        const out: TradeCenterOffer[] = [];
        for (const offer of offersField.children) {
            if (offer.name === "…" || !offer.children) continue;
            const auctionId = intFromField(findField(offer.children, proto.fields.Offer_auctionId));
            if (auctionId === null) continue;
            out.push({
                auctionId,
                typeId: intFromField(findField(offer.children, proto.fields.Offer_typeId)) ?? 0,
                itemId: intFromField(findField(offer.children, proto.fields.Offer_itemId)) ?? 0,
                statsCount: arrayLength(findField(offer.children, proto.fields.Offer_stats)) ?? 0,
                prices: intArrayFromField(findField(offer.children, proto.fields.Offer_prices)),
            });
        }
        return out;
    }
}
