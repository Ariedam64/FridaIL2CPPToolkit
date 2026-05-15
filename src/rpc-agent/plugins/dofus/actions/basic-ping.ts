// BasicPing (jsa) sender — keepalive heartbeat the client normally emits
// every ~5s during active sessions (activity-gated, see basic-ping.md).
// When automation forges WS sends via Frida, the client's natural activity
// counter doesn't tick, so we emit our own jsa to keep the server side
// from flagging the session as stalled.

import { inVm, getLiveInstance, findClass } from "./_runtime";

export interface BasicPingProto {
    classes: {
        BasicPing:  string;
        Dispatcher: string;
    };
    fields: {
        BasicPing_flag2: string;
    };
    methods: {
        Dispatcher_send: string;
    };
}

export interface SendBasicPingResult { ok: boolean; reason?: string }

/** Forge a BasicPing (jsa) and dispatch it. The observed wire shape sets
 *  elyw (flag2) to true and leaves the others at proto default. */
export function sendBasicPing(proto: BasicPingProto): Promise<SendBasicPingResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.BasicPing);
        if (!reqK) return { ok: false, reason: `${proto.classes.BasicPing} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };
        let req: any;
        try {
            req = (reqK as any).new();
            req.method(".ctor").overload().invoke();
            req.field(proto.fields.BasicPing_flag2).value = true;
        } catch (e) {
            return { ok: false, reason: `${proto.classes.BasicPing} build failed: ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}
