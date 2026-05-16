// Backend façade for the NPC dialog protocol (hwd → hwy → hwp → jms). Used
// by the autopilot for transit NPCs that handle map changes via dialogue
// (boats, elevators, "fast-travel" NPCs) instead of static interactives.
//
// The flow is wire-driven: after forging hwd we wait for the natural hwy
// (NpcDialogQuestionMessage) so we can extract the server-allocated
// `questionId`, then forge hwp with that id and reply index 0. For transit
// NPCs the dialog has exactly one option ("Do you want to travel?"), so the
// fixed reply index is correct; multi-option dialogs would need a strategy
// — out of scope here.

import type { LabelStore } from "../../../../backend/core/labels";
import type { FrameStore } from "../../../../backend/core/network/frame-store";
import type { RpcClient } from "../../../../backend/core/types";
import { NPC_DIALOG_PROTO, type ResolvedNpcDialogProto } from "../protocol/schema";
import { resolveProto } from "../protocol/resolver";
import { waitForFrame, latestFrameId } from "../frame-await";
import type { NetworkFrame, FrameField } from "../../../../backend/core/network/types";

export interface NpcDialogResult {
    ok: boolean;
    npcEntityId: number;
    questionId?: number;
    replyIndex?: number;
    timeline?: {
        hwdSentAt?:  number;
        hwyArrived?: number;
        hwpSentAt?:  number;
        jmsArrived?: number;
    };
    reason?: string;
}

interface SendResult { ok: boolean; reason?: string }

const DEFAULT_QUESTION_TIMEOUT_MS = 5_000;
const DEFAULT_LEAVE_TIMEOUT_MS    = 5_000;

/** Walks the children tree of a captured frame looking for the first field
 *  whose name matches `obfName`. Returns its integer preview, or null. */
function findIntField(fields: readonly FrameField[] | undefined, obfName: string): number | null {
    if (!fields) return null;
    for (const f of fields) {
        if (f.name === obfName) {
            const n = Number(f.preview);
            return Number.isFinite(n) ? n : null;
        }
        if (f.children) {
            const sub = findIntField(f.children, obfName);
            if (sub !== null) return sub;
        }
    }
    return null;
}

export class NpcDialogActions {
    constructor(
        private readonly labels: LabelStore,
        private readonly rpc: RpcClient,
        private readonly frameStore: () => FrameStore | null,
    ) {}

    private proto(): ResolvedNpcDialogProto {
        return resolveProto(this.labels, NPC_DIALOG_PROTO) as ResolvedNpcDialogProto;
    }

    /** Open a dialog with `npcEntityId` and auto-reply with index 0. Resolves
     *  when jms arrives (dialog closed) — the caller is expected to await
     *  the natural map change separately.
     *
     *  Wire-level flow (mirrors the official client minus the jmr prelude,
     *  which empirically isn't required for transit NPCs):
     *    OUT hwd → IN hwh → IN hwy (open + read question)
     *    OUT hwp(replyIndex=0) → IN jms (commit reply, close)
     */
    async talkAndAutoReply(npcEntityId: number, mapId: number): Promise<NpcDialogResult> {
        const fs = this.frameStore();
        if (!fs) return { ok: false, npcEntityId, reason: "no network frame store — start the network capture first" };

        const proto = this.proto();
        const timeline: NonNullable<NpcDialogResult["timeline"]> = {};

        // -----------------------------------------------------------------
        // Open dialog — hwd → hwy
        // -----------------------------------------------------------------
        const sinceId = latestFrameId(fs);
        // Arm the wait BEFORE sending hwd so we don't miss hwy on a tight
        // server (the network round-trip is fast enough that the frame can
        // land before the await registers).
        const questionP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.DialogQuestion,
            DEFAULT_QUESTION_TIMEOUT_MS,
            sinceId,
        );

        // actionId=3 = "Parler / Talk" (default NPC dialog action). Passed
        // explicitly because Frida's RPC marshalling doesn't preserve TS
        // default-parameter values when the host omits the arg — it forwards
        // `undefined` to the agent, which `undefined | 0` coerces to 0 and
        // the server then refuses the dialog (responds without hwy).
        const NPC_ACTION_TALK = 3;
        const sentTalk = await this.rpc.call<SendResult>("sendTalkToNpc", [proto, npcEntityId, mapId, NPC_ACTION_TALK]);
        timeline.hwdSentAt = Date.now();
        if (!sentTalk.ok) return { ok: false, npcEntityId, timeline, reason: `hwd: ${sentTalk.reason}` };

        const question = await questionP;
        if (!question) return { ok: false, npcEntityId, timeline, reason: `timeout waiting for ${proto.classes.DialogQuestion} (hwy)` };
        timeline.hwyArrived = question.timestamp;

        // Extract questionId from the inbound hwy frame. The protobuf nests
        // it inside `content[0].questionId` — we walk the field tree by the
        // resolved obf name (NOT a hardcoded "eatj") so the migration engine
        // can rekey it after an obfuscation rotation without code changes.
        const questionIdObf = proto.fields.QuestionContent_questionId;
        const questionId = findIntField(question.fields, questionIdObf);
        if (questionId === null) {
            return { ok: false, npcEntityId, timeline, reason: `couldn't extract questionId (${questionIdObf}) from hwy frame` };
        }

        // Arm leave-wait BEFORE sending the reply for the same reason as above.
        const leaveSinceId = latestFrameId(fs);
        const leaveP = waitForFrame(
            fs,
            (f) => f.direction === "in" && f.typeKey.className === proto.classes.DialogLeave,
            DEFAULT_LEAVE_TIMEOUT_MS,
            leaveSinceId,
        );

        const sentReply = await this.rpc.call<SendResult>("sendNpcDialogReply", [proto, questionId, 0]);
        timeline.hwpSentAt = Date.now();
        if (!sentReply.ok) return { ok: false, npcEntityId, questionId, replyIndex: 0, timeline, reason: `hwp: ${sentReply.reason}` };

        const leave = await leaveP;
        if (leave) timeline.jmsArrived = leave.timestamp;
        // jms isn't strictly required — sometimes the server skips it and
        // jumps straight to knw. We return ok regardless; the caller awaits
        // the map change as the real success signal.
        return { ok: true, npcEntityId, questionId, replyIndex: 0, timeline };
    }
}

/** Exposed for tests — pure tree walker that finds the first int-typed field
 *  matching `obfName` in a captured FrameField tree. */
export { findIntField as __findIntField_for_tests };
