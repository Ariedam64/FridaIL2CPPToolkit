// WebSocket connection + typed event bus.

export interface WatchlistTickPayload {
    type: "watchlist-tick";
    values: Record<string, string>;
}

export type WsEvent =
    | { type: "hello"; attached: { pid: number; name: string } | null }
    | { type: "attached"; pid: number; name: string }
    | { type: "detached"; reason?: string }
    | { type: "message"; message: WatchlistTickPayload | { type: string; [k: string]: unknown } };

type Handler = (ev: WsEvent) => void;

const handlers: Handler[] = [];
let socket: WebSocket | null = null;
let retryDelay = 500;

export function onWsEvent(fn: Handler): () => void {
    handlers.push(fn);
    return () => { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); };
}

export function connect(): void {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    socket = new WebSocket(url);
    socket.addEventListener("open", () => { retryDelay = 500; console.log("[ws] open"); });
    socket.addEventListener("message", (e) => {
        try {
            const data = JSON.parse(String(e.data)) as WsEvent;
            for (const h of handlers) { try { h(data); } catch (err) { console.error("[ws] handler error", err); } }
        } catch (err) { console.error("[ws] bad payload", err, e.data); }
    });
    socket.addEventListener("close", () => {
        console.warn(`[ws] closed, retry in ${retryDelay}ms`);
        socket = null;
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
    });
    socket.addEventListener("error", () => { try { socket?.close(); } catch {} });
}
