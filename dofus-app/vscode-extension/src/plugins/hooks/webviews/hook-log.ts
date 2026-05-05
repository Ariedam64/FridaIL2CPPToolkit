// dofus-app/vscode-extension/src/plugins/hooks/webviews/hook-log.ts
import * as vscode from "vscode";

import type { HookEventBus } from "../hook-event-bus";
import type { HookStore } from "../hook-store";

export class HookLogPanel {
    private panel: vscode.WebviewPanel | null = null;
    private busSub: (() => void) | null = null;
    private storeSub: (() => void) | null = null;
    private paused = false;

    constructor(
        private readonly bus: HookEventBus,
        private readonly store: HookStore,
    ) {}

    show(focusHookId?: string): void {
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                "fridaHookLog",
                "Hook Log",
                vscode.ViewColumn.Beside,
                { enableScripts: true, retainContextWhenHidden: true },
            );
            this.panel.webview.html = this.html();
            this.panel.onDidDispose(() => this.teardown());
            this.panel.webview.onDidReceiveMessage((m: { type: string; value?: unknown; body?: unknown }) => {
                if (m.type === "pause") this.paused = true;
                if (m.type === "resume") this.paused = false;
                if (m.type === "clear") this.bus.clear();
                if (m.type === "export") {
                    void vscode.window.showSaveDialog({
                        defaultUri: vscode.Uri.file(`hook-log-${Date.now()}.json`),
                        filters: { JSON: ["json"] },
                    }).then((uri) => {
                        if (!uri) return;
                        return vscode.workspace.fs.writeFile(uri, Buffer.from(String(m.value ?? m.body ?? ""), "utf-8"));
                    });
                }
            });

            // Replay ring buffer on first open.
            this.panel.webview.postMessage({ type: "init", events: this.bus.snapshot(), hooks: this.store.list() });

            this.busSub = this.bus.onHookEvent((e) => {
                if (this.paused) return;
                this.panel?.webview.postMessage({ type: "event", event: e });
            });
            this.storeSub = this.store.onChange(() => {
                this.panel?.webview.postMessage({ type: "hooks", hooks: this.store.list() });
            });
        }
        this.panel.reveal();
        if (focusHookId) {
            const stored = this.store.list().find((h) => h.id === focusHookId);
            this.panel.webview.postMessage({
                type: "focus",
                hookId: focusHookId,
                className: stored?.spec.className,
                methodName: stored?.spec.methodName,
            });
        }
    }

    private teardown(): void {
        this.busSub?.();
        this.storeSub?.();
        this.busSub = null;
        this.storeSub = null;
        this.panel = null;
    }

    dispose(): void {
        this.panel?.dispose();
        this.teardown();
    }

    private html(): string {
        return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            body { font-family: var(--vscode-editor-font-family); color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background); margin: 0; padding: 0; }
            .toolbar { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border);
                display: flex; gap: 8px; align-items: center; position: sticky; top: 0;
                background: var(--vscode-editor-background); }
            button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            #filter { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border); padding: 3px 6px; flex: 1; min-width: 100px; }
            #stream { padding: 0 10px; font-family: var(--vscode-editor-font-family); font-size: 12px; }
            .row { padding: 2px 0; border-bottom: 1px dotted var(--vscode-panel-border); white-space: pre-wrap; word-break: break-word; }
            .row.expanded .details { display: block; }
            .details { display: none; padding: 4px 0 4px 16px; color: var(--vscode-descriptionForeground); }
            .ts { color: var(--vscode-descriptionForeground); margin-right: 6px; }
            .cls { color: var(--vscode-symbolIcon-classForeground, var(--vscode-textLink-foreground)); }
            .args { color: var(--vscode-textPreformat-foreground); }
            .ret { color: var(--vscode-charts-green); }
            .err { color: var(--vscode-errorForeground); }
            .tab.active { font-weight: bold; }
        </style></head><body>
            <div class="toolbar">
                <button id="tab-stream"  class="tab active">Stream</button>
                <button id="tab-summary" class="tab">Summary</button>
                <button id="pause">Pause</button>
                <button id="clear">Clear</button>
                <button id="export">Export JSON</button>
                <input id="filter" placeholder="Filter — text in args/retval/class/method" />
                <span id="count" style="opacity:.7"></span>
            </div>
            <div id="stream"></div>
            <table id="summary" style="display:none; width:100%; border-collapse:collapse;">
                <thead><tr>
                    <th align="left">Hook</th>
                    <th align="right">Hits</th>
                    <th align="left">Last hit</th>
                    <th align="left">Last args</th>
                    <th align="left">Last retval / err</th>
                </tr></thead>
                <tbody></tbody>
            </table>
            <script>
                const vscode = acquireVsCodeApi();
                let paused = false;
                let filterText = "";
                let hookSpecs = new Map();
                const stream = document.getElementById("stream");
                const countEl = document.getElementById("count");
                const filterInput = document.getElementById("filter");
                const pauseBtn = document.getElementById("pause");
                const clearBtn = document.getElementById("clear");
                const exportBtn = document.getElementById("export");
                const tabStream = document.getElementById("tab-stream");
                const tabSummary = document.getElementById("tab-summary");
                const summaryEl = document.getElementById("summary");

                let totalSeen = 0;
                let shown = 0;
                const HARD_LIMIT = 5000;
                const summary = new Map(); // hookId -> { hits, lastTs, lastArgs, lastRet, lastErr, spec }

                function rebuildHookSpecs(hooks) {
                    hookSpecs = new Map();
                    for (const h of hooks) {
                        if (h.installedHookId) hookSpecs.set(h.installedHookId, h.spec);
                    }
                }

                function bumpSummary(e) {
                    let s = summary.get(e.hookId);
                    if (!s) {
                        s = { hits: 0, lastTs: 0, lastArgs: [], lastRet: null, lastErr: null,
                              spec: hookSpecs.get(e.hookId) ?? null };
                        summary.set(e.hookId, s);
                    }
                    s.hits++;
                    s.lastTs = e.ts;
                    s.lastArgs = e.args;
                    s.lastRet = e.retval;
                    s.lastErr = e.error ?? null;
                    s.spec = hookSpecs.get(e.hookId) ?? s.spec;
                }

                function renderSummary() {
                    const rows = [];
                    const sorted = [...summary.entries()].sort((a, b) => b[1].hits - a[1].hits);
                    for (const [hookId, s] of sorted) {
                        const name = s.spec ? (s.spec.className + "." + s.spec.methodName) : hookId;
                        const tail = s.lastErr
                            ? "<span class=err>throw " + escape(s.lastErr) + "</span>"
                            : "<span class=ret>" + escape(s.lastRet ?? "void") + "</span>";
                        rows.push(
                            "<tr><td>" + escape(name) + "</td>" +
                            "<td align=right>" + s.hits + "</td>" +
                            "<td>" + new Date(s.lastTs).toISOString().slice(11,23) + "</td>" +
                            "<td>(" + escape(s.lastArgs.join(", ")) + ")</td>" +
                            "<td>" + tail + "</td></tr>",
                        );
                    }
                    summaryEl.querySelector("tbody").innerHTML = rows.join("");
                }

                function showStream() {
                    tabStream.classList.add("active");
                    tabSummary.classList.remove("active");
                    stream.style.display = "";
                    summaryEl.style.display = "none";
                }
                function showSummary() {
                    tabStream.classList.remove("active");
                    tabSummary.classList.add("active");
                    stream.style.display = "none";
                    summaryEl.style.display = "";
                    renderSummary();
                }
                tabStream.addEventListener("click", showStream);
                tabSummary.addEventListener("click", showSummary);

                function fmtRow(e) {
                    const spec = hookSpecs.get(e.hookId);
                    const cls = spec ? spec.className : e.hookId;
                    const m = spec ? spec.methodName : "?";
                    const args = e.args.join(", ");
                    const ret = e.error ? "<span class=err>throw " + escape(e.error) + "</span>"
                        : "<span class=ret>" + escape(e.retval ?? "void") + "</span>";
                    const ts = new Date(e.ts).toISOString().slice(11, 23);
                    const stackHtml = (e.stackFrames && e.stackFrames.length)
                        ? "<div class=details>stack:<br>" + e.stackFrames.map(escape).join("<br>") + "</div>"
                        : "";
                    return "<div class=row><span class=ts>" + ts + "</span>" +
                        "<span class=cls>" + escape(cls + "." + m) + "</span> " +
                        "<span class=args>(" + escape(args) + ")</span> → " + ret +
                        stackHtml + "</div>";
                }

                function escape(s) {
                    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                }

                function matches(e) {
                    if (!filterText) return true;
                    const haystack = [
                        hookSpecs.get(e.hookId)?.className ?? "",
                        hookSpecs.get(e.hookId)?.methodName ?? "",
                        ...(e.args ?? []),
                        e.retval ?? "",
                        e.error ?? "",
                    ].join(" ").toLowerCase();
                    return haystack.indexOf(filterText) >= 0;
                }

                function append(e) {
                    bumpSummary(e);
                    totalSeen++;
                    if (!matches(e)) { updateCount(); return; }
                    stream.insertAdjacentHTML("beforeend", fmtRow(e));
                    shown++;
                    while (stream.children.length > HARD_LIMIT) {
                        stream.removeChild(stream.firstChild);
                    }
                    if (!paused) stream.lastElementChild?.scrollIntoView({ block: "nearest" });
                    updateCount();
                    if (summaryEl.style.display !== "none") renderSummary();
                }

                function updateCount() {
                    countEl.textContent = shown + " shown / " + totalSeen + " total";
                }

                function rerenderAll(events) {
                    summary.clear();
                    for (const e of events) bumpSummary(e);
                    stream.innerHTML = "";
                    shown = 0;
                    totalSeen = events.length;
                    for (const e of events) {
                        if (matches(e)) {
                            stream.insertAdjacentHTML("beforeend", fmtRow(e));
                            shown++;
                        }
                    }
                    updateCount();
                    if (summaryEl.style.display !== "none") renderSummary();
                }

                stream.addEventListener("click", (ev) => {
                    const row = ev.target.closest(".row");
                    if (row) row.classList.toggle("expanded");
                });

                filterInput.addEventListener("input", () => {
                    filterText = filterInput.value.toLowerCase();
                    rerenderAll(__lastSnapshot);
                });

                pauseBtn.addEventListener("click", () => {
                    paused = !paused;
                    pauseBtn.textContent = paused ? "Resume" : "Pause";
                    vscode.postMessage({ type: paused ? "pause" : "resume" });
                });

                clearBtn.addEventListener("click", () => {
                    stream.innerHTML = "";
                    summary.clear();
                    if (summaryEl.style.display !== "none") renderSummary();
                    totalSeen = 0; shown = 0;
                    updateCount();
                    vscode.postMessage({ type: "clear" });
                });

                exportBtn.addEventListener("click", () => {
                    const blob = JSON.stringify(__lastSnapshot, null, 2);
                    vscode.postMessage({ type: "export", body: blob });
                });

                let __lastSnapshot = [];
                window.addEventListener("message", (msg) => {
                    const m = msg.data;
                    if (m.type === "init") {
                        rebuildHookSpecs(m.hooks);
                        __lastSnapshot = m.events.slice();
                        rerenderAll(__lastSnapshot);
                    } else if (m.type === "hooks") {
                        rebuildHookSpecs(m.hooks);
                    } else if (m.type === "event") {
                        __lastSnapshot.push(m.event);
                        if (__lastSnapshot.length > 10000) __lastSnapshot.shift();
                        append(m.event);
                    } else if (m.type === "focus") {
                        const filter = m.className && m.methodName
                            ? (m.className + "." + m.methodName)
                            : (m.hookId || "");
                        filterInput.value = filter;
                        filterText = filter.toLowerCase();
                        rerenderAll(__lastSnapshot);
                        showStream();
                    }
                });
            </script>
        </body></html>`;
    }
}
