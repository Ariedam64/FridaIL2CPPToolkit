// Socket panel — network capture with scrolling dedicated log.
import { rpcCall } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";
import { logRpcLine, logRpcResult } from "./logs.js";

// Aliases persist across re-renders via localStorage
const socketAliases: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem("socketAliases") || "{}") as Record<string, string>; }
    catch { return {}; }
})();
function saveAliases(): void { localStorage.setItem("socketAliases", JSON.stringify(socketAliases)); }

interface SocketPayload {
    direction?: string;
    cls?: string;
    name?: string;
    fullName?: string;
    ts?: number;
    fields?: Record<string, unknown>;
}

async function runAction(action: string, args: unknown[]): Promise<void> {
    logRpcLine(`[rpc] ${action}(${args.map(a => JSON.stringify(a)).join(", ")})`);
    try {
        const result = await rpcCall(action, args);
        logRpcResult(action, result);
    } catch (err) {
        logRpcLine(`[rpc] ${action} failed: ${String(err)}`);
    }
}

export function renderSocket(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); height:100%">

        <div class="section-header">network capture</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="sendClass"  value="ecu" placeholder="send class"  style="flex:1">
          <input class="input" data-arg="sendMethod" value="xbe" placeholder="send method" style="flex:1">
          <button class="btn primary" data-action="startNetworkCapture">start</button>
          <button class="btn"         data-action="stopNetworkCapture">stop</button>
        </div>

        <div class="section-header">capture log <span class="meta">socket events only</span></div>
        <div style="display:flex; gap:var(--s-2); align-items:center">
          <input class="input" id="socket-filter-input" placeholder="filter by class…" style="flex:1">
          <label style="display:flex;align-items:center;gap:4px;color:var(--ink-muted);font-size:11.5px;cursor:pointer">
            <input type="checkbox" id="socket-autoscroll-cb" checked style="accent-color:var(--accent)"> auto-scroll
          </label>
          <button class="btn" id="socket-clear-btn">clear</button>
        </div>

        <div id="socket-log-inner"
             style="flex:1; overflow:auto; font-family:var(--font-mono); font-size:11.5px;
                    border:1px solid var(--border-soft); border-radius:var(--r-md);
                    background:var(--surface-inset)">
        </div>

      </div>
    `;

    const socketLogEl      = container.querySelector("#socket-log-inner")      as HTMLElement;
    const filterInput      = container.querySelector("#socket-filter-input")    as HTMLInputElement;
    const autoscrollCb     = container.querySelector("#socket-autoscroll-cb")   as HTMLInputElement;
    const clearBtn         = container.querySelector("#socket-clear-btn")       as HTMLButtonElement;

    let socketFilter = "";

    clearBtn.addEventListener("click", () => { socketLogEl.innerHTML = ""; });

    filterInput.addEventListener("input", () => {
        socketFilter = filterInput.value.trim();
        socketLogEl.querySelectorAll<HTMLElement>(".socket-entry").forEach(el => {
            const match = !socketFilter || new RegExp(socketFilter, "i").test(el.dataset.cls ?? "");
            el.classList.toggle("filtered-out", !match);
        });
    });

    // Start/stop buttons
    const actionRow = container.querySelector(".action-row") as HTMLElement;
    actionRow.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn || !btn.dataset.action) return;
        const action = btn.dataset.action;
        const inputs = [...actionRow.querySelectorAll<HTMLInputElement>("[data-arg]")];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });
        const args = [vals["sendClass"] || "ecu", vals["sendMethod"] || "xbe"];
        void runAction(action, args);
    });

    function pushSocketEvent(p: SocketPayload): void {
        const entry = document.createElement("div");
        entry.className = "socket-entry " + (p.direction || "out");
        entry.dataset.cls = p.cls || "?";
        entry.style.cssText = `
            display:flex; align-items:flex-start; gap:var(--s-2);
            padding:4px var(--s-2); border-bottom:1px solid var(--border-soft);
            cursor:pointer;
        `;

        const ts = new Date(p.ts ?? Date.now()).toLocaleTimeString();
        const dirSymbol = p.direction === "in" ? "↓" : "↑";
        const dirColor = p.direction === "in" ? "var(--ok)" : "var(--accent)";

        const tsEl = document.createElement("span");
        tsEl.style.cssText = "color:var(--ink-disabled);min-width:70px;font-size:10.5px";
        tsEl.textContent = ts;

        const dirEl = document.createElement("span");
        dirEl.style.cssText = `color:${dirColor};min-width:14px;font-weight:700`;
        dirEl.textContent = dirSymbol;

        const clsEl = document.createElement("span");
        clsEl.className = "cls";
        clsEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

        const autoName   = (p.name && p.name !== "?") ? p.name : null;
        const manualAlias = socketAliases[p.cls ?? ""];
        const displayName = autoName || manualAlias || null;
        if (displayName) {
            const flag = manualAlias ? "★" : "";
            clsEl.innerHTML = `<span style="color:var(--ink-primary)">${displayName}${flag}</span> <span style="color:var(--ink-disabled)">(${p.cls})</span>`;
        } else {
            clsEl.textContent = p.cls || "?";
        }

        // detail pre (hidden by default, expanded on click)
        const previewEl = document.createElement("pre");
        previewEl.style.cssText = "display:none; font-size:10.5px; margin-top:4px; width:100%; color:var(--ink-muted)";
        const lines: string[] = [];
        if (p.fullName && p.fullName !== "?") lines.push(`[${p.fullName}]`);
        if (p.fields && Object.keys(p.fields).length) {
            for (const [k, val] of Object.entries(p.fields)) lines.push(`  ${k} = ${String(val)}`);
        } else {
            lines.push("(no field set)");
        }
        lines.push("");
        lines.push("right-click to set alias for this class");
        previewEl.textContent = lines.join("\n");

        // wrap cls + preview in a flex-col div
        const infoCol = document.createElement("div");
        infoCol.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column";
        infoCol.appendChild(clsEl);
        infoCol.appendChild(previewEl);

        entry.appendChild(tsEl);
        entry.appendChild(dirEl);
        entry.appendChild(infoCol);

        entry.addEventListener("click", () => {
            const shown = previewEl.style.display !== "none";
            previewEl.style.display = shown ? "none" : "";
        });

        entry.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            const current = socketAliases[p.cls ?? ""] || "";
            const next = prompt(`Alias for "${p.cls ?? "?"}":`, current);
            if (next === null) return;
            if (next === "") { delete socketAliases[p.cls ?? ""]; }
            else { socketAliases[p.cls ?? ""] = next; }
            saveAliases();
            // refresh all existing entries with this cls
            socketLogEl.querySelectorAll<HTMLElement>(`.socket-entry[data-cls="${p.cls}"]`).forEach(el => {
                const c = el.querySelector(".cls");
                if (!c) return;
                const aliased = socketAliases[p.cls ?? ""];
                if (aliased) {
                    c.innerHTML = `<span style="color:var(--ink-primary)">${aliased}★</span> <span style="color:var(--ink-disabled)">(${p.cls})</span>`;
                } else {
                    c.textContent = p.cls || "?";
                }
            });
        });

        if (socketFilter && !new RegExp(socketFilter, "i").test(p.cls || "")) {
            entry.classList.add("filtered-out");
        }

        socketLogEl.appendChild(entry);
        if (autoscrollCb.checked) socketLogEl.scrollTop = socketLogEl.scrollHeight;
    }

    // Subscribe to socket events via WS
    onWsEvent((ev) => {
        if (ev.type !== "message") return;
        const m = ev.message;
        if (m.type !== "send") return;
        const p = m["payload"] as Record<string, unknown> | null | undefined;
        if (!p || typeof p !== "object") return;
        if (p["type"] !== "socket") return;
        pushSocketEvent(p as unknown as SocketPayload);
    });
}
