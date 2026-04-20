// Logs panel — live event stream in the right column #log container.
import { onWsEvent } from "../lib/ws.js";
import { copyMarkdown, formatLogSession } from "../lib/clipboard.js";

// Helpers ported from app.js
function escapeHtml(s: string): string {
    return s.replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c] ?? c));
}

function hlSpan(cls: string, text: string): string {
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

function highlightDumpLine(line: string): string {
    let m: RegExpMatchArray | null;

    m = line.match(/^(=+\s*)(.+?)(\s*=+)$/);
    if (m) return hlSpan("hl-hdr", m[1]) + hlSpan("hl-hdr", m[2]) + hlSpan("hl-hdr", m[3]);

    m = line.match(/^(\s*)(parent)(\s*:\s*)(.*)$/);
    if (m) return escapeHtml(m[1]) + hlSpan("hl-label", m[2]) + escapeHtml(m[3]) + hlSpan("hl-type", m[4]);

    m = line.match(/^(\s*)((?:instance fields|static fields|methods|classes|fields)\s*\([^)]*\))(\s*:\s*)$/);
    if (m) return escapeHtml(m[1]) + hlSpan("hl-label", m[2]) + escapeHtml(m[3]);

    m = line.match(/^(\s*)(static\s+)?(\S+)(\s+)([A-Za-z_][\w.<>``,]*)\(([^)]*)\)(.*)$/);
    if (m) {
        const [, indent, kw, type, pad, name, args, tail] = m;
        return (
            escapeHtml(indent) +
            (kw ? hlSpan("hl-kw", kw.trimEnd()) + escapeHtml(" ") : "") +
            hlSpan("hl-type", type) +
            escapeHtml(pad) +
            hlSpan("hl-method", name) +
            escapeHtml("(") +
            hlSpan("hl-args", args) +
            escapeHtml(")") +
            escapeHtml(tail)
        );
    }

    m = line.match(/^(\s*)(\S+)(\s+)(\S+)(\s*=\s*)(.*)$/);
    if (m) {
        const [, indent, type, pad1, name, eq, val] = m;
        return (
            escapeHtml(indent) +
            hlSpan("hl-type", type) +
            escapeHtml(pad1) +
            hlSpan("hl-field", name) +
            escapeHtml(eq) +
            hlSpan("hl-val", val)
        );
    }

    m = line.match(/^(\s*)(\S+)(\s+)(\S+)\s*$/);
    if (m) {
        const [, indent, type, pad, name] = m;
        return escapeHtml(indent) + hlSpan("hl-type", type) + escapeHtml(pad) + hlSpan("hl-field", name);
    }

    return escapeHtml(line);
}

function highlightDump(text: string): string {
    return text.split("\n").map(highlightDumpLine).join("\n");
}

// Module-level state so the log element can be accessed from logRpc helper below
let logEl: HTMLElement | null = null;
const showFilters = { log: true, hook: true, rpc: true };

// Ring buffer for "Copy session" — capped at 200 entries
const LOG_RING_MAX = 200;
type LogEntry = { ts: string; cls: string; text: string };
const logRing: LogEntry[] = [];

function isVisible(cls: string): boolean {
    if (cls === "log")  return showFilters.log;
    if (cls === "hook") return showFilters.hook;
    if (cls === "rpc")  return showFilters.rpc;
    return true;
}

function appendLine(text: string, cls = "log"): void {
    const ts = new Date().toLocaleTimeString();
    // Push to ring buffer (always, even if logEl not yet mounted)
    logRing.push({ ts, cls, text });
    if (logRing.length > LOG_RING_MAX) logRing.shift();

    if (!logEl) return;
    const div = document.createElement("div");
    div.className = `line ${cls}`;
    div.dataset.cls = cls;
    div.innerHTML = `<span class="ts" style="color:var(--ink-disabled);margin-right:8px">${ts}</span>`;
    div.appendChild(document.createTextNode(text));
    if (!isVisible(cls)) div.style.display = "none";
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

// Batching for consecutive log lines (port from app.js)
let logBatch: string[] = [];
let logBatchTimer: ReturnType<typeof setTimeout> | null = null;

function pushLogLine(text: string): void {
    logBatch.push(text);
    if (logBatchTimer !== null) clearTimeout(logBatchTimer);
    logBatchTimer = setTimeout(flushLogBatch, 120);
}

function flushLogBatch(): void {
    if (logBatchTimer !== null) { clearTimeout(logBatchTimer); logBatchTimer = null; }
    const batch = logBatch;
    logBatch = [];
    if (!batch.length) return;
    if (batch.length === 1) { appendLine(batch[0], "log"); return; }
    renderLogBlock(batch);
}

function renderLogBlock(lines: string[]): void {
    if (!logEl) return;
    const wrap = document.createElement("div");
    wrap.className = "line log block";
    wrap.dataset.cls = "log";

    const firstReal = lines.find(l => /=== /.test(l)) || "";
    const titleMatch = firstReal.match(/=+\s*(.+?)\s*=+$/);
    const title = titleMatch ? titleMatch[1] : `output · ${lines.length} lines`;

    const header = document.createElement("div");
    header.className = "block-header";
    header.style.cssText = "display:flex;align-items:center;gap:8px;padding:3px 0;cursor:pointer;user-select:none";

    const toggle = document.createElement("span");
    toggle.style.cssText = "color:var(--accent);width:12px;display:inline-block";
    toggle.textContent = "▾";

    const tsEl = document.createElement("span");
    tsEl.style.cssText = "color:var(--ink-disabled);font-size:11px";
    tsEl.textContent = new Date().toLocaleTimeString();

    const titleEl = document.createElement("span");
    titleEl.style.cssText = "color:var(--ink-muted)";
    titleEl.textContent = title;

    const count = document.createElement("span");
    count.className = "tag";
    count.style.marginLeft = "auto";
    count.textContent = `${lines.length} lines`;

    header.appendChild(toggle);
    header.appendChild(tsEl);
    header.appendChild(titleEl);
    header.appendChild(count);

    const pre = document.createElement("pre");
    pre.style.cssText = "font-size:11.5px;line-height:1.5;padding:4px 0 4px 16px;overflow-x:auto";
    pre.innerHTML = highlightDump(lines.join("\n"));

    if (lines.length > 40) {
        pre.style.display = "none";
        toggle.textContent = "▸";
    }

    header.addEventListener("click", () => {
        const collapsed = pre.style.display === "none";
        pre.style.display = collapsed ? "" : "none";
        toggle.textContent = collapsed ? "▾" : "▸";
    });

    wrap.appendChild(header);
    wrap.appendChild(pre);

    if (!isVisible("log")) wrap.style.display = "none";
    logEl.appendChild(wrap);
    logEl.scrollTop = logEl.scrollHeight;
}

/** Log an RPC action line — called by other panels. */
export function logRpcLine(text: string): void { appendLine(text, "rpc"); }

/** Log an RPC result — ported from app.js logResult. */
export function logRpcResult(action: string, result: unknown): void {
    if (result === undefined || result === null) return;
    if (Array.isArray(result)) {
        if (result.length === 0) { appendLine(`[rpc]   → [] (empty)`, "rpc"); return; }
        appendLine(`[rpc]   → [${result.length} items]`, "rpc");
        for (const item of result) {
            if (action === "find" && typeof item === "string") {
                logClassLink(item);
            } else {
                const s = typeof item === "string" ? item : JSON.stringify(item);
                appendLine(`        · ${s}`, "rpc");
            }
        }
        return;
    }
    if (typeof result === "object") {
        const pretty = JSON.stringify(result, null, 2);
        for (const line of pretty.split("\n")) appendLine(`        ${line}`, "rpc");
        return;
    }
    const s = typeof result === "string" ? result : String(result);
    appendLine(`[rpc]   → ${s}`, "rpc");
}

function logClassLink(name: string): void {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = "line rpc";
    div.dataset.cls = "rpc";
    const ts = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="ts" style="color:var(--ink-disabled);margin-right:8px">${ts}</span>        · `;
    const link = document.createElement("a");
    link.href = "#";
    link.style.cssText = "color:var(--accent);text-decoration:none";
    link.textContent = name;
    link.title = "click: dump · shift+click: dump statics";
    link.onclick = (ev) => {
        ev.preventDefault();
        const action = ev.shiftKey ? "dumpStatics" : "dumpClass";
        document.querySelectorAll<HTMLInputElement>('[data-arg="className"],[data-arg="name"]')
            .forEach(inp => { inp.value = name; });
        document.dispatchEvent(new CustomEvent("dump-class", { detail: { name, action } }));
    };
    div.appendChild(link);
    if (!isVisible("rpc")) div.style.display = "none";
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

export function mountLogs(container: HTMLElement): void {
    logEl = container;

    // Insert "Copy session" button above the log container in its parent
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn";
    copyBtn.title = "copy recent log entries as markdown for Claude";
    copyBtn.textContent = "📋 Copy session";
    copyBtn.style.cssText = "margin-bottom:var(--s-2);align-self:flex-start";
    copyBtn.addEventListener("click", () => {
        void copyMarkdown(formatLogSession([...logRing]), copyBtn);
    });
    container.parentElement?.insertBefore(copyBtn, container);

    // Wire filter checkboxes if they exist in the document
    for (const kind of ["log", "hook", "rpc"] as const) {
        const cb = document.getElementById(`show-${kind}`) as HTMLInputElement | null;
        if (cb) {
            cb.addEventListener("change", (ev) => {
                showFilters[kind] = (ev.target as HTMLInputElement).checked;
                container.querySelectorAll<HTMLElement>(".line").forEach(line => {
                    if (line.dataset.cls === kind) {
                        line.style.display = showFilters[kind] ? "" : "none";
                    }
                });
            });
        }
    }

    onWsEvent((ev) => {
        if (ev.type === "message") {
            const m = ev.message;
            if (m.type === "log") {
                const payload = m["payload"];
                pushLogLine(typeof payload === "string" ? payload : JSON.stringify(payload));
            } else if (m.type === "send") {
                flushLogBatch();
                const p = m["payload"] as Record<string, unknown> | null | undefined;
                if (!p || typeof p !== "object") {
                    appendLine(String(p), "log");
                } else if (p["type"] === "hook") {
                    const argsStr = ((p["args"] as unknown[]) || []).join(", ");
                    const ret = p["error"] ? `THREW ${p["error"]}` : `→ ${p["retval"]}`;
                    appendLine(`${p["cls"]}.${p["method"]}(${argsStr}) ${ret}  [${p["self"] || "static"}]`, "hook");
                    const stackFrames = p["stack"] as string[] | undefined;
                    if (stackFrames && stackFrames.length > 0 && logEl) {
                        const wrap = document.createElement("div");
                        wrap.className = "line hook";
                        wrap.dataset.cls = "hook";
                        wrap.style.cssText = "padding-left:16px";
                        const toggle = document.createElement("span");
                        toggle.style.cssText = "color:var(--ink-muted);cursor:pointer;font-size:11px;user-select:none";
                        toggle.textContent = `▸ stack (${stackFrames.length} frames)`;
                        const pre = document.createElement("pre");
                        pre.style.cssText = "display:none;font-size:10.5px;line-height:1.5;color:var(--ink-muted);padding:4px 0 4px 12px;overflow-x:auto";
                        pre.textContent = stackFrames.join("\n");
                        toggle.addEventListener("click", () => {
                            const collapsed = pre.style.display === "none";
                            pre.style.display = collapsed ? "" : "none";
                            toggle.textContent = collapsed ? `▾ stack (${stackFrames.length} frames)` : `▸ stack (${stackFrames.length} frames)`;
                        });
                        wrap.appendChild(toggle);
                        wrap.appendChild(pre);
                        if (!isVisible("hook")) wrap.style.display = "none";
                        logEl.appendChild(wrap);
                        logEl.scrollTop = logEl.scrollHeight;
                    }
                } else if (p["type"] === "agent-ready") {
                    appendLine(`[agent] ready`, "ok");
                } else if (p["type"] === "socket") {
                    // socket events handled in socket panel; show brief summary here
                    appendLine(`[net] ${p["cls"] ?? "?"} ${p["direction"] === "in" ? "↓" : "↑"}`, "hook");
                } else if (p["type"] === "watchlist-tick") {
                    // watchlist ticks are consumed by the watchlist panel; don't spam the log
                } else {
                    appendLine(JSON.stringify(p), "log");
                }
            } else if (m.type === "error") {
                flushLogBatch();
                const stack = m["stack"] ? `\n${String(m["stack"])}` : "";
                appendLine(`[script-error] ${m["description"] || m["fileName"] || JSON.stringify(m)}${stack}`, "err");
            }
        } else if (ev.type === "attached") {
            appendLine(`[host] attached to ${ev.name} (${ev.pid})`, "ok");
        } else if (ev.type === "detached") {
            appendLine(`[host] detached${ev.reason ? ` (${ev.reason})` : ""}`, "host");
        } else if (ev.type === "hello") {
            appendLine(`[host] ws connected`, "ok");
        }
    });
}
