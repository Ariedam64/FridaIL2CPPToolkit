// Host wrapper for the BasicPing (jsa) keepalive packet. The Dofus client
// normally emits jsa every ~5s while there is in-flight WS activity. When we
// drive moves and map changes via Frida, the client's natural activity counter
// is bypassed, so we have to send our own jsa to keep the server from flagging
// the session as stalled — that desync is what produces the visible glitches
// during automated travel (snap-back, asset thrash, UI freeze).

import type { LabelStore } from "../../../../backend/core/labels";
import type { RpcClient } from "../../../../backend/core/types";
import { BASIC_PING_PROTO, type ResolvedBasicPingProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";

interface SendResult { ok: boolean; reason?: string }

export class BasicPingActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
    ) {}

    private proto(): ResolvedBasicPingProto {
        return resolveProto(this.labels, BASIC_PING_PROTO) as ResolvedBasicPingProto;
    }

    /** Forge + dispatch a single BasicPing. Best-effort — callers typically
     *  don't care about the result (it's a keepalive). */
    async sendPing(): Promise<SendResult> {
        return this.rpc.call<SendResult>("sendBasicPing", [this.proto()]);
    }
}
