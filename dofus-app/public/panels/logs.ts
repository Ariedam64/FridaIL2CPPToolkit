// Lightweight log surface for the Dofus app — no per-class filters, no
// markdown export, no batching. Just a chronological event stream.
import { onWsEvent } from "../lib/ws.js";

let logEl: HTMLElement | null = null;

function append(text: string, cls = "log"): void {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.dataset.cls = cls;
    const ts = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="ts" style="color:var(--ink-disabled);margin-right:8px">${ts}</span>`;
    div.appendChild(document.createTextNode(text));
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

export function logRpcLine(text: string): void { append(text, "rpc"); }

export function mountLogs(container: HTMLElement): void {
    logEl = container;
    onWsEvent((ev) => {
        if (ev.type === "attached") append(`[host] attached to ${ev.name} (${ev.pid})`, "ok");
        else if (ev.type === "detached") append(`[host] detached${ev.reason ? ` (${ev.reason})` : ""}`, "host");
        else if (ev.type === "hello") append(`[host] ws connected`, "ok");
        else if (ev.type === "message") {
            const m = ev.message as Record<string, unknown>;
            if (m["type"] === "log") {
                const p = m["payload"];
                append(typeof p === "string" ? p : JSON.stringify(p), "log");
            } else if (m["type"] === "send") {
                const p = m["payload"] as Record<string, unknown> | null | undefined;
                if (p && typeof p === "object") {
                    if (p["type"] === "agent-ready") append(`[agent] ready`, "ok");
                    else if (p["type"] === "socket") {
                        const dir = p["direction"] === "in" ? "↓" : "↑";
                        append(`[net] ${p["cls"] ?? "?"} ${dir}`, "hook");
                    } else if (p["type"] === "autopilot-done") {
                        append(`[autopilot] arrival event`, "ok");
                    }
                    // catalog-dump / map-cache / cartography-tile are silent
                    // — they're expected high-volume payloads.
                }
            } else if (m["type"] === "error") {
                append(`[script-error] ${m["description"] || JSON.stringify(m)}`, "err");
            }
        }
    });
}
