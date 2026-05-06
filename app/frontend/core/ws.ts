// app/frontend/core/ws.ts — WebSocket client + dispatcher

type Handler = (payload: any) => void;

let _ws: WebSocket | null = null;
const handlers = new Map<string, Set<Handler>>();

function ensure(): WebSocket {
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) {
        return _ws;
    }
    const url = location.protocol === "https:" ? "wss://" : "ws://";
    _ws = new WebSocket(`${url}${location.host}/events`);
    _ws.addEventListener("message", (m) => {
        let data: any;
        try { data = JSON.parse(m.data); } catch { return; }
        if (!data || typeof data.type !== "string") return;
        const set = handlers.get(data.type);
        if (set) for (const h of set) { try { h(data); } catch (e) { console.error(e); } }
    });
    _ws.addEventListener("close", () => {
        // Attempt reconnect after 1s.
        setTimeout(() => { _ws = null; ensure(); }, 1000);
    });
    return _ws;
}

export function subscribe(type: string, handler: Handler): () => void {
    ensure();
    let set = handlers.get(type);
    if (!set) { set = new Set(); handlers.set(type, set); }
    set.add(handler);
    return () => set!.delete(handler);
}

export function connectWs(): void { ensure(); }
