import type { Session } from "../../session.js";
import type { FrameField, NetworkFrame, TypeKey } from "./types.js";

interface AgentNetworkFramePayload {
    type: "network-frame";
    direction: "in" | "out";
    timestamp: number;
    typeKey: TypeKey;
    fields: FrameField[];
    truncated?: boolean;
}

interface AgentAutoRevertPayload {
    type: "network-auto-revert";
    entry: {
        className: string;
        ns: string | null;
        methodName: string;
        direction: "send" | "recv";
    };
    reason: string;
    detail?: string;
}

interface AgentFrameErrorPayload {
    type: "network-frame-error";
    entryId: string;
    error: string;
}

type AgentPayload = AgentNetworkFramePayload | AgentAutoRevertPayload | AgentFrameErrorPayload | { type: string };

/**
 * Wires `agent-message` events to the per-profile network stores.
 * Idempotent: re-attaching disposes the previous binding.
 */
export function mountNetworkEventBus(session: Session): () => void {
    const handler = (payload: AgentPayload): void => {
        if (!payload || typeof payload !== "object") return;
        if (payload.type === "network-frame") {
            const p = payload as AgentNetworkFramePayload;
            const store = session.frameStore();
            if (!store) return;
            const partial: Omit<NetworkFrame, "id"> = {
                timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
                direction: p.direction === "out" ? "out" : "in",
                typeKey: p.typeKey,
                fields: Array.isArray(p.fields) ? p.fields : [],
                truncated: p.truncated === true ? true : undefined,
            };
            store.push(partial);
        } else if (payload.type === "network-auto-revert") {
            const p = payload as AgentAutoRevertPayload;
            const cfg = session.serializerConfigStore();
            if (!cfg) return;
            if (!p.entry || !p.entry.className || !p.entry.methodName) return;
            cfg.markStale(
                {
                    className: p.entry.className,
                    ns: p.entry.ns,
                    methodName: p.entry.methodName,
                    direction: p.entry.direction,
                },
                true,
            );
        } else if (payload.type === "network-frame-error") {
            const p = payload as AgentFrameErrorPayload;
            const store = session.frameStore();
            if (!store) return;
            // Render errors as synthetic frames so they're visible in the Stream.
            store.push({
                timestamp: Date.now(),
                direction: "in",
                typeKey: { ns: "_error", className: p.entryId },
                fields: [{ name: "error", kind: "string", preview: p.error.slice(0, 200) }],
            });
        }
    };
    session.on("agent-message", handler);
    return () => session.off("agent-message", handler);
}
