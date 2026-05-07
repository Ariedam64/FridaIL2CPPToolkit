// WS / Socket panel for the dofus-app — simplified port of the toolkit's
// socket.ts. Drops the preset/signature/snapshot system (toolkit-specific)
// and keeps the live capture log: outgoing (ecu.xbe) + incoming (fzk.Decode)
// hooks, filterable scroll, pause, group-dupes, autoscroll.

import { rpcCall } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";
import { logRpcLine } from "./logs.js";

interface SocketPayload {
    direction?: string;
    cls?: string;
    name?: string;
    fullName?: string;
    ts?: number;
    fields?: Record<string, unknown>;
}

function prettyFieldName(name: string): string {
    const m = name.match(/^<([^>]+)>k__BackingField$/);
    return m ? m[1] : name;
}

function fieldsToString(fields?: Record<string, unknown>): string {
    if (!fields) return "";
    const parts: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
        let s: string;
        if (v === null || v === undefined) s = "null";
        else if (typeof v === "object") s = JSON.stringify(v).slice(0, 60);
        else s = String(v).slice(0, 60);
        parts.push(`${prettyFieldName(k)}=${s}`);
    }
    return parts.join(" ");
}

let mountUnsub: (() => void) | null = null;

export function renderSocket(container: HTMLElement): void {
    if (mountUnsub) { mountUnsub(); mountUnsub = null; }
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); height:100%; overflow:hidden">

        <fieldset style="border:1px solid #333; padding:var(--s-2); border-radius:4px">
          <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">outgoing — hook IMessage send (↑ class.method(msg))</legend>
          <div style="display:flex; gap:var(--s-2)">
            <input id="ws-send-cls" value="ecu" placeholder="send class" style="flex:1; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
            <input id="ws-send-mtd" value="xbe" placeholder="send method" style="flex:1; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
            <button id="ws-out-start" class="btn primary">start</button>
            <button id="ws-out-stop" class="btn">stop</button>
          </div>
        </fieldset>

        <fieldset style="border:1px solid #333; padding:var(--s-2); border-radius:4px">
          <legend style="padding:0 var(--s-2); color:var(--c-label); font-size:11px">incoming — hook decoder output (↓ decode(_, msg, output))</legend>
          <div style="display:flex; gap:var(--s-2)">
            <input id="ws-recv-cls" value="fzk" placeholder="recv class" style="flex:1; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
            <input id="ws-recv-mtd" value="Decode" placeholder="recv method" style="flex:1; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
            <input id="ws-recv-idx" value="2" placeholder="output arg idx" style="max-width:60px; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
            <button id="ws-in-start" class="btn primary">start</button>
            <button id="ws-in-stop" class="btn">stop</button>
          </div>
        </fieldset>

        <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap">
          <input id="ws-filter" placeholder="filter by class regex (click row's class to toggle)..." style="flex:1; min-width:180px; padding:2px 4px; background:#111; border:1px solid #333; color:#fff; font-family:var(--font-mono); font-size:11px">
          <label style="display:flex;align-items:center;gap:4px;color:var(--c-label);font-size:11px;cursor:pointer">
            <input type="checkbox" id="ws-autoscroll" checked> auto-scroll
          </label>
          <label style="display:flex;align-items:center;gap:4px;color:var(--c-label);font-size:11px;cursor:pointer">
            <input type="checkbox" id="ws-group" checked> group dupes
          </label>
          <button id="ws-pause" class="btn">⏸ pause</button>
          <button id="ws-clear" class="btn">clear</button>
          <span id="ws-stats" style="font-size:11px; color:var(--c-label); font-family:var(--font-mono)">0 events · 0 types · 0 ev/s</span>
        </div>

        <div id="ws-log" style="flex:1; overflow:auto; font-family:var(--font-mono); font-size:11px; border:1px solid #333; border-radius:4px; background:#0a0a0a; padding:var(--s-1)"></div>
      </div>
    `;

    const $ = <T extends HTMLElement>(s: string) => container.querySelector<T>(s)!;
    const logEl       = $<HTMLDivElement>("#ws-log");
    const filterInput = $<HTMLInputElement>("#ws-filter");
    const autoscrollCb= $<HTMLInputElement>("#ws-autoscroll");
    const groupCb     = $<HTMLInputElement>("#ws-group");
    const pauseBtn    = $<HTMLButtonElement>("#ws-pause");
    const clearBtn    = $<HTMLButtonElement>("#ws-clear");
    const statsEl     = $<HTMLSpanElement>("#ws-stats");
    const sendCls     = $<HTMLInputElement>("#ws-send-cls");
    const sendMtd     = $<HTMLInputElement>("#ws-send-mtd");
    const recvCls     = $<HTMLInputElement>("#ws-recv-cls");
    const recvMtd     = $<HTMLInputElement>("#ws-recv-mtd");
    const recvIdx     = $<HTMLInputElement>("#ws-recv-idx");

    let filterRegex = "";
    let paused = false;
    const pauseBuffer: SocketPayload[] = [];
    const eventTimes: number[] = [];
    const classCounts = new Map<string, number>();
    let totalEvents = 0;
    let lastEntry: { el: HTMLElement; cls: string; count: number; countEl: HTMLElement; tsEl: HTMLElement } | null = null;

    function updateStats(): void {
        const now = Date.now();
        while (eventTimes.length && now - eventTimes[0]! > 5000) eventTimes.shift();
        const rate = (eventTimes.length / 5).toFixed(1);
        statsEl.textContent = `${totalEvents} events · ${classCounts.size} types · ${rate} ev/s`;
    }
    const statsTimer = setInterval(updateStats, 500);

    function applyFilter(): void {
        logEl.querySelectorAll<HTMLElement>(".ws-row").forEach(el => {
            const match = !filterRegex || new RegExp(filterRegex, "i").test(el.dataset["cls"] ?? "");
            el.style.display = match ? "" : "none";
        });
    }

    function pushEvent(p: SocketPayload): void {
        if (paused) {
            if (pauseBuffer.length < 2000) pauseBuffer.push(p);
            return;
        }
        totalEvents++;
        eventTimes.push(Date.now());
        const cls = p.cls || p.fullName || p.name || "?";
        classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);

        if (groupCb.checked && lastEntry && lastEntry.cls === cls) {
            lastEntry.count++;
            lastEntry.countEl.textContent = `×${lastEntry.count}`;
            lastEntry.tsEl.textContent = new Date().toLocaleTimeString();
            if (autoscrollCb.checked) logEl.scrollTop = logEl.scrollHeight;
            return;
        }

        const row = document.createElement("div");
        row.className = "ws-row";
        row.dataset["cls"] = cls;
        row.style.cssText = "padding:1px 4px; border-bottom:1px solid #1a1a1a; white-space:pre";
        const dirArrow = p.direction === "out" ? "↑" : p.direction === "in" ? "↓" : "·";
        const dirColor = p.direction === "out" ? "#fc4" : p.direction === "in" ? "#4af" : "#888";
        const tsStr = new Date().toLocaleTimeString();
        const fStr = fieldsToString(p.fields).slice(0, 200);
        row.innerHTML = `
          <span class="ws-ts" style="color:#888">${tsStr}</span>
          <span style="color:${dirColor}; margin:0 4px">${dirArrow}</span>
          <span class="ws-cls" data-cls="${cls}" style="color:#fff; cursor:pointer; text-decoration:underline">${cls}</span>
          <span class="ws-count" style="color:#aaa; margin-left:4px"></span>
          <span style="color:var(--c-label); margin-left:8px">${fStr.replace(/</g, "&lt;")}</span>
        `;
        // Toggle filter on cls click
        row.querySelector<HTMLElement>(".ws-cls")!.addEventListener("click", (e) => {
            e.stopPropagation();
            filterInput.value = filterInput.value === cls ? "" : cls;
            filterRegex = filterInput.value.trim();
            applyFilter();
        });
        logEl.appendChild(row);
        // Cap at 2000 rows
        while (logEl.childElementCount > 2000) logEl.firstElementChild?.remove();

        const countEl = row.querySelector<HTMLElement>(".ws-count")!;
        const tsEl    = row.querySelector<HTMLElement>(".ws-ts")!;
        lastEntry = { el: row, cls, count: 1, countEl, tsEl };

        if (filterRegex && !new RegExp(filterRegex, "i").test(cls)) row.style.display = "none";
        if (autoscrollCb.checked) logEl.scrollTop = logEl.scrollHeight;
    }

    // ---- WS subscription ----
    // Event shape: { type:"message", message:{ type:"send", payload:{ type:"socket", cls, ... } } }
    // (Frida send() wraps as `send` envelope; the agent's actual payload is in `.payload`.)
    mountUnsub = onWsEvent((ev) => {
        if (ev.type !== "message") return;
        const m = (ev as any).message;
        if (m?.type !== "send") return;
        const p = m.payload;
        if (p?.type !== "socket") return;
        pushEvent({
            direction: p.direction,
            cls: p.cls,
            name: p.name,
            fullName: p.fullName,
            ts: p.ts,
            fields: p.fields,
        });
    });

    // ---- buttons ----
    filterInput.addEventListener("input", () => { filterRegex = filterInput.value.trim(); applyFilter(); });
    pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.textContent = paused ? `▶ resume${pauseBuffer.length ? ` (${pauseBuffer.length})` : ""}` : "⏸ pause";
        if (!paused) { for (const p of pauseBuffer.splice(0, pauseBuffer.length)) pushEvent(p); }
    });
    clearBtn.addEventListener("click", () => { logEl.innerHTML = ""; lastEntry = null; });

    $<HTMLButtonElement>("#ws-out-start").addEventListener("click", async () => {
        try {
            const r = await rpcCall<any>("startNetworkCapture", [sendCls.value, sendMtd.value]);
            logRpcLine(`[ws] outgoing capture started: ${JSON.stringify(r).slice(0, 100)}`);
        } catch (err) { logRpcLine(`[ws] outgoing start err: ${String(err).slice(0, 100)}`); }
    });
    $<HTMLButtonElement>("#ws-out-stop").addEventListener("click", async () => {
        try { await rpcCall<any>("stopNetworkCapture", []); logRpcLine("[ws] outgoing capture stopped"); }
        catch (err) { logRpcLine(`[ws] outgoing stop err: ${String(err).slice(0, 100)}`); }
    });
    $<HTMLButtonElement>("#ws-in-start").addEventListener("click", async () => {
        try {
            const r = await rpcCall<any>("startIncomingCapture", [recvCls.value, recvMtd.value, parseInt(recvIdx.value, 10) || 2]);
            logRpcLine(`[ws] incoming capture started: ${JSON.stringify(r).slice(0, 100)}`);
        } catch (err) { logRpcLine(`[ws] incoming start err: ${String(err).slice(0, 100)}`); }
    });
    $<HTMLButtonElement>("#ws-in-stop").addEventListener("click", async () => {
        try { await rpcCall<any>("stopIncomingCapture", []); logRpcLine("[ws] incoming capture stopped"); }
        catch (err) { logRpcLine(`[ws] incoming stop err: ${String(err).slice(0, 100)}`); }
    });

    // Cleanup on unmount-via-tab-change. main.ts replaces the container's
    // children when switching tabs, but our WS subscription would leak.
    const observer = new MutationObserver(() => {
        if (!container.isConnected) {
            mountUnsub?.(); mountUnsub = null;
            clearInterval(statsTimer);
            observer.disconnect();
        }
    });
    observer.observe(container.parentElement ?? document.body, { childList: true });
}
