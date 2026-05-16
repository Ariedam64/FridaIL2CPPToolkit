// NPC dialog senders — forge `hwd` (open dialog) and `hwp` (reply). Reads the
// inbound `hwy` (question content) happen entirely on the backend via the
// FrameStore; the agent only dispatches outgoing.

import { inVm, getLiveInstance, findClass } from "./_runtime";

export interface NpcDialogProto {
    classes: {
        LeaveRequest:   string;
        TalkRequest:    string;
        Reply:          string;
        DialogQuestion: string;
        DialogLeave:    string;
        Dispatcher:     string;
    };
    fields: {
        TalkRequest_npcEntityId: string;
        TalkRequest_actionId:    string;
        TalkRequest_mapId:       string;
        Reply_replyIndex:        string;
        Reply_questionId:        string;
        DialogQuestion_textId:   string;
        DialogQuestion_content:  string;
    };
    methods: {
        Dispatcher_send: string;
    };
}

export interface NpcDialogSendResult { ok: boolean; reason?: string }

/** Forge a NpcDialogLeaveRequest (jmr) and dispatch it. Empty payload — sent
 *  before each new hwd so the server's per-player dialog state is clean. */
export function sendNpcDialogLeave(proto: NpcDialogProto): Promise<NpcDialogSendResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.LeaveRequest);
        if (!reqK) return { ok: false, reason: `${proto.classes.LeaveRequest} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };
        let req: any;
        try {
            req = (reqK as any).new();
            req.method(".ctor").overload().invoke();
        } catch (e) {
            return { ok: false, reason: `${proto.classes.LeaveRequest} build failed: ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}

/** Forge a TalkToNpcRequest (hwd) and dispatch it. `npcEntityId` is the
 *  negative id from the itx entities list (-20000, -20001…), `actionId` is
 *  3 for the default "talk" action (observed on transit NPCs). */
export function sendTalkToNpc(
    proto: NpcDialogProto,
    npcEntityId: number,
    mapId: number,
    actionId: number = 3,
): Promise<NpcDialogSendResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.TalkRequest);
        if (!reqK) return { ok: false, reason: `${proto.classes.TalkRequest} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

        let req: any;
        let stage = "init";
        try {
            req = (reqK as any).new();
            stage = "ctor";
            req.method(".ctor").overload().invoke();
            stage = `set ${proto.fields.TalkRequest_npcEntityId}`;
            req.field(proto.fields.TalkRequest_npcEntityId).value = npcEntityId | 0;
            stage = `set ${proto.fields.TalkRequest_actionId}`;
            req.field(proto.fields.TalkRequest_actionId).value = actionId | 0;
            stage = `set ${proto.fields.TalkRequest_mapId}`;
            req.field(proto.fields.TalkRequest_mapId).value = mapId;
        } catch (e) {
            return { ok: false, reason: `hwd build failed at "${stage}": ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}

/** Forge a NpcDialogReplyMessage (hwp) and dispatch it. `replyIndex` is the
 *  index into hwy's reply list (0 for the first option — sufficient for
 *  transit NPCs which only have one). `questionId` is extracted by the host
 *  from the inbound hwy frame (lives in hwy.content[0].questionId / eatj). */
export function sendNpcDialogReply(
    proto: NpcDialogProto,
    questionId: number,
    replyIndex: number = 0,
): Promise<NpcDialogSendResult> {
    return inVm(() => {
        const reqK = findClass(proto.classes.Reply);
        if (!reqK) return { ok: false, reason: `${proto.classes.Reply} class not found` };
        const dispatcher = getLiveInstance(proto.classes.Dispatcher);
        if (!dispatcher) return { ok: false, reason: `no live ${proto.classes.Dispatcher} instance` };

        let req: any;
        let stage = "init";
        try {
            req = (reqK as any).new();
            stage = "ctor";
            req.method(".ctor").overload().invoke();
            stage = `set ${proto.fields.Reply_replyIndex}`;
            req.field(proto.fields.Reply_replyIndex).value = replyIndex | 0;
            stage = `set ${proto.fields.Reply_questionId}`;
            req.field(proto.fields.Reply_questionId).value = questionId | 0;
        } catch (e) {
            return { ok: false, reason: `hwp build failed at "${stage}": ${String(e).slice(0, 200)}` };
        }
        try {
            (dispatcher as any).method(proto.methods.Dispatcher_send).invoke(req);
            return { ok: true };
        } catch (e) {
            return { ok: false, reason: `dispatcher send failed: ${String(e).slice(0, 200)}` };
        }
    });
}
