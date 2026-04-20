// Watchlist panel — live readouts for pinned fields, updated on watchlist-tick.
import { onWsEvent, WatchlistTickPayload } from "../lib/ws.js";
import { rpcCall } from "../lib/rpc.js";
import { copyMarkdown, formatWatchlist } from "../lib/clipboard.js";

type PinMeta = {
    label: string;
    lastValue: string;
    el: HTMLElement;
};

const pins = new Map<string, PinMeta>();
let containerEl: HTMLElement | null = null;
let emptyEl: HTMLElement | null = null;

function makeEmptyState(): HTMLElement {
    const el = document.createElement("div");
    el.className = "readout idle";
    el.innerHTML = `<span class="dot"></span><span class="k">no pins yet</span><span class="v">—</span><span class="d"></span>`;
    return el;
}

function showEmpty(): void {
    if (!containerEl || emptyEl) return;
    emptyEl = makeEmptyState();
    containerEl.appendChild(emptyEl);
}

function hideEmpty(): void {
    if (!emptyEl) return;
    emptyEl.remove();
    emptyEl = null;
}

function tryParseDelta(prev: string, next: string): { text: string; cls: string } | null {
    const a = parseFloat(prev);
    const b = parseFloat(next);
    if (isNaN(a) || isNaN(b)) return null;
    const d = b - a;
    if (d === 0) return null;
    const sign = d > 0 ? "+" : "−";
    const absStr = String(Math.abs(d) % 1 === 0 ? Math.abs(d) : Math.abs(d).toFixed(4));
    return { text: `${sign}${absStr}`, cls: d > 0 ? "d up" : "d down" };
}

function addReadout(id: string, label: string, initialValue = ""): void {
    if (!containerEl) return;
    hideEmpty();

    const el = document.createElement("div");
    el.className = "readout";
    el.dataset["pinId"] = id;
    el.innerHTML = `
        <span class="dot"></span>
        <span class="k">${label}</span>
        <span class="v">${initialValue || "…"}</span>
        <span class="d"></span>
        <button class="btn unpin-btn" title="unpin" data-unpin-id="${id}">×</button>
    `;
    containerEl.appendChild(el);
    pins.set(id, { label, lastValue: initialValue, el });
}

function removeReadout(id: string): void {
    const meta = pins.get(id);
    if (!meta) return;
    meta.el.remove();
    pins.delete(id);
    if (pins.size === 0) showEmpty();
}

function handleTick(payload: WatchlistTickPayload): void {
    for (const [id, value] of Object.entries(payload.values)) {
        const meta = pins.get(id);
        if (!meta) continue;
        const vEl = meta.el.querySelector(".v");
        const dEl = meta.el.querySelector(".d");
        if (!vEl || !dEl) continue;
        const delta = tryParseDelta(meta.lastValue, value);
        vEl.textContent = value;
        if (delta) {
            dEl.textContent = delta.text;
            dEl.className = delta.cls;
        } else {
            dEl.textContent = "";
            dEl.className = "d";
        }
        meta.lastValue = value;
    }
}

export async function refreshFromServer(): Promise<void> {
    try {
        type PinInfo = { id: string; label?: string; className: string; fieldName: string };
        const serverPins = await rpcCall<PinInfo[]>("listPins");
        for (const p of serverPins) {
            if (!pins.has(p.id)) {
                addReadout(p.id, p.label ?? `${p.className}.${p.fieldName}`);
            }
        }
    } catch {
        // agent not attached yet; silently ignore
    }
}

export function mountWatchlist(container: HTMLElement): void {
    containerEl = container;
    container.replaceChildren();

    // Header row with "Copy state" button
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--s-2)";
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.title = "copy watchlist as markdown for Claude";
    copyBtn.textContent = "📋 Copy state";
    copyBtn.addEventListener("click", () => {
        const readouts = [...pins.values()].map(m => ({
            label: m.label,
            value: m.lastValue,
        }));
        void copyMarkdown(formatWatchlist(readouts), copyBtn);
    });
    header.appendChild(copyBtn);
    container.appendChild(header);

    showEmpty();

    // Subscribe to tick events
    onWsEvent((ev) => {
        if (ev.type !== "message") return;
        const m = ev.message;
        if (m.type === "watchlist-tick") {
            handleTick(m as WatchlistTickPayload);
        }
    });

    // Unpin button delegation
    container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-unpin-id]") as HTMLElement | null;
        if (!btn) return;
        const id = btn.dataset["unpinId"]!;
        removeReadout(id);
        void rpcCall("unpin", [id]);
    });

    // Sync with server pins (in case of page reload while agent running)
    void refreshFromServer();
}

/** Called by instance panel after a successful pinField RPC to add a new readout. */
export function addWatchlistPin(id: string, label: string): void {
    addReadout(id, label);
}
