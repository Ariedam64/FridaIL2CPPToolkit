// Backend façade for map change. Two modes:
//
//   default ("clean") — single outgoing packet (ito). The Dofus client's
//     own loading coroutine handles jnr+isp after the asset bundle finishes
//     loading, which is what wires up the Unity scene (camera, player
//     entity, etc.). Total ~1.5s but UI remains consistent.
//
//   fast — single-RPC blast: agent arms a dispatcher hook that drops the
//     client's jnr+isp, then sends ito+jnr+isp back-to-back. Total ~300ms
//     but the client's scene setup is skipped (no character visible,
//     can't move from UI). Intended for headless automation only.

import type { LabelStore } from "../../../../backend/core/labels";
import type { FrameStore } from "../../../../backend/core/network/frame-store";
import type { RpcClient } from "../../../../backend/core/types";
import { CHANGE_MAP_PROTO, type ResolvedChangeMapProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";
import { waitForFrame, latestFrameId } from "../frame-await";

export interface ChangeMapOptions {
    /** Skip the client's loading coroutine for ~5x speedup. WARNING: leaves
     *  the in-game UI broken (no character sprite, can't move via UI) until
     *  the next map change resets state. Bot use only. */
    fast?: boolean;
}

export interface ChangeMapResult {
    ok: boolean;
    mapId: number;
    mode: "clean" | "fast";
    timeline?: {
        sentAt: number;
        gotTransitionAck?: number;
        gotMapEventsList?: number;
    };
    reason?: string;
}

interface SendResult {
    ok: boolean;
    reason?: string;
    timings?: { buildMs: number; sendMs: number; totalMs: number };
}

const DEFAULT_COMPLETE_TIMEOUT_MS = 15_000;
/** Fast mode: how long after kta we keep the intercept armed, so the game's
 *  late auto-emission of jnr+isp (which lags ~1.2s behind knw) still gets
 *  dropped. */
const INTERCEPT_RELEASE_GRACE_MS  = 2_500;

export class ChangeMapActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
        private readonly frameStore: () => FrameStore | null,
    ) {}

    private proto(): ResolvedChangeMapProto {
        return resolveProto(this.labels, CHANGE_MAP_PROTO) as ResolvedChangeMapProto;
    }

    async changeMap(mapId: number, options: ChangeMapOptions = {}): Promise<ChangeMapResult> {
        return options.fast
            ? this.changeMapFast(mapId)
            : this.changeMapClean(mapId);
    }

    /** Send `ito` and wait for `kta`. The client itself emits jnr+isp via its
     *  internal loading coroutine; we don't interfere. Slower (~1.5s) but
     *  the UI state stays consistent. */
    private async changeMapClean(mapId: number): Promise<ChangeMapResult> {
        const fs = this.frameStore();
        if (!fs) return { ok: false, mapId, mode: "clean", reason: "no network frame store — start the network capture first" };

        const proto = this.proto();
        const timeline: NonNullable<ChangeMapResult["timeline"]> = { sentAt: 0 };
        const sinceId = latestFrameId(fs);

        const ackP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.TransitionAck,
            DEFAULT_COMPLETE_TIMEOUT_MS,
            sinceId,
        );
        const completeP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.MapEventsList,
            DEFAULT_COMPLETE_TIMEOUT_MS,
            sinceId,
        );

        const tRpcStart = Date.now();
        const sentIto = await this.rpc.call<SendResult>("sendMoveToNewMap", [proto, mapId]);
        const rpcTotalMs = Date.now() - tRpcStart;
        timeline.sentAt = Date.now();
        console.log(`[change-map] ito rpc=${rpcTotalMs}ms agent_build=${sentIto.timings?.buildMs ?? "?"}ms agent_send=${sentIto.timings?.sendMs ?? "?"}ms agent_total=${sentIto.timings?.totalMs ?? "?"}ms`);
        if (!sentIto.ok) return { ok: false, mapId, mode: "clean", timeline, reason: `ito send failed: ${sentIto.reason}` };

        const ack = await ackP;
        if (ack) timeline.gotTransitionAck = ack.timestamp;

        const complete = await completeP;
        if (!complete) return { ok: false, mapId, mode: "clean", timeline, reason: `timeout waiting for ${proto.classes.MapEventsList} (mapEventsList)` };
        timeline.gotMapEventsList = complete.timestamp;

        return { ok: true, mapId, mode: "clean", timeline };
    }

    /** Single-RPC fast path: arm dispatcher intercept + send ito+jnr+isp
     *  back-to-back. Caller is responsible for accepting the UI-broken
     *  state until the next change. */
    private async changeMapFast(mapId: number): Promise<ChangeMapResult> {
        const fs = this.frameStore();
        if (!fs) return { ok: false, mapId, mode: "fast", reason: "no network frame store — start the network capture first" };

        const proto = this.proto();
        const timeline: NonNullable<ChangeMapResult["timeline"]> = { sentAt: 0 };
        const sinceId = latestFrameId(fs);

        const ackP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.TransitionAck,
            DEFAULT_COMPLETE_TIMEOUT_MS,
            sinceId,
        );
        const completeP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.MapEventsList,
            DEFAULT_COMPLETE_TIMEOUT_MS,
            sinceId,
        );

        const sent = await this.rpc.call<SendResult>("fastChangeMap", [proto, mapId]);
        timeline.sentAt = Date.now();

        const releaseIntercept = (): void => {
            this.rpc.call<SendResult>("setChangeMapIntercept", [proto, []])
                .catch(() => { /* best-effort */ });
        };

        if (!sent.ok) {
            setTimeout(releaseIntercept, 0);
            return { ok: false, mapId, mode: "fast", timeline, reason: `fastChangeMap failed: ${sent.reason}` };
        }

        const ack = await ackP;
        if (ack) timeline.gotTransitionAck = ack.timestamp;

        const complete = await completeP;
        if (!complete) {
            setTimeout(releaseIntercept, 0);
            return { ok: false, mapId, mode: "fast", timeline, reason: `timeout waiting for ${proto.classes.MapEventsList} (mapEventsList)` };
        }
        timeline.gotMapEventsList = complete.timestamp;

        // Keep the intercept armed for a grace period so the game's late
        // auto-emission of jnr+isp still gets dropped.
        setTimeout(releaseIntercept, INTERCEPT_RELEASE_GRACE_MS);

        return { ok: true, mapId, mode: "fast", timeline };
    }
}
