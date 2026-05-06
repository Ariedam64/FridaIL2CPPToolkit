// app/backend/ws-bridge.ts
//
// Broadcasts session events (Frida send() payloads, label/annotation/hook
// changes, profile attach/detach) to all connected WebSocket clients on /events.

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Session } from "./session.js";

interface OutboundEvent {
    type: string;
    payload?: unknown;
    [k: string]: unknown;
}

export function mountWsBridge(server: HttpServer, session: Session): void {
    const wss = new WebSocketServer({ server, path: "/events" });

    const clients = new Set<WebSocket>();
    wss.on("connection", (ws) => {
        clients.add(ws);
        ws.on("close", () => clients.delete(ws));
    });

    const broadcast = (evt: OutboundEvent): void => {
        const data = JSON.stringify(evt);
        for (const c of clients) {
            if (c.readyState === c.OPEN) {
                try { c.send(data); } catch { /* drop */ }
            }
        }
    };

    session.on("agent-message", (payload: unknown) => {
        // Pass through hook-event / hook-auto-revert / agent-ready / etc.
        if (payload && typeof payload === "object" && "type" in (payload as Record<string, unknown>)) {
            broadcast(payload as OutboundEvent);
        } else {
            broadcast({ type: "agent-message", payload });
        }
    });
    session.on("label-change", (evt) => broadcast({ type: "label-change", ...evt }));
    session.on("annotation-change", (evt) => broadcast({ type: "annotation-change", ...evt }));
    session.on("hook-store-change", () => broadcast({ type: "hook-store-change" }));
    session.on("profile-attached", (profile) => broadcast({
        type: "profile-attached",
        profile: { manifest: profile.manifest, rootPath: profile.rootPath },
    }));
    session.on("profile-detached", () => broadcast({ type: "profile-detached" }));
}
