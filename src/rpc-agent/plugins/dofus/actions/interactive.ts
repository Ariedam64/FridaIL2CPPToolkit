// InteractiveUseRequest sender — fires the iev outgoing packet for any
// interactive on the current map (resource node, NPC merchant, zaap, ...).
// The backend is responsible for resolving the right `skillInstanceUid` from
// MapInteractivesStore before calling here; this agent code never inspects
// runtime state itself, it only forges and dispatches the packet.

import { inVm, getLiveInstance, findClass } from "./_runtime";

// Same shape as TradeCenterProto's iev subset, but field keys reflect the
// generic interactive-use semantics rather than the HDV-flavoured ones.
export interface InteractiveProto {
    classes: {
        UseRequest: string;
        Dispatcher: string;
    };
    fields: {
        UseRequest_flag1:            string;
        UseRequest_elementId:        string;
        UseRequest_skillInstanceUid: string;
        UseRequest_flag2:            string;
    };
    methods: {
        Dispatcher_send: string;
    };
}

export interface SendUseInteractiveResult {
    ok: boolean;
    reason?: string;
}

/** Forge an InteractiveUseRequest (iev) and dispatch it.
 *  - `elementId` = id of the target interactive on the current map (kne.erqk)
 *  - `skillInstanceUid` = server-allocated UID of the skill to invoke on it
 *    (knc.erqd, taken from the `enabledSkills` list of that element). */
export function sendUseInteractive(
    proto: InteractiveProto,
    elementId: number,
    skillInstanceUid: number,
): Promise<SendUseInteractiveResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.UseRequest);
        if (!reqK) return { ok: false, reason: `${proto.classes.UseRequest} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

        let req: any;
        try {
            req = (reqK as any).new();
            req.method(".ctor").overload().invoke();
            // Position-sensitive in protobuf: flag1, elementId, skillInstanceUid, flag2.
            // The first field (ecop) stays at its default (null/0).
            req.field(proto.fields.UseRequest_flag1).value = 0;
            req.field(proto.fields.UseRequest_elementId).value = elementId;
            req.field(proto.fields.UseRequest_skillInstanceUid).value = skillInstanceUid;
            req.field(proto.fields.UseRequest_flag2).value = 0;
        } catch (e) {
            return { ok: false, reason: `${proto.classes.UseRequest} build failed: ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true } as SendUseInteractiveResult;
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}
