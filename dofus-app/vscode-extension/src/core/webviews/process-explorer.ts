// Webview replacement for the VSCode TreeDataProvider Process Explorer.
//
// VSCode trees render every visible item as a DOM/widget tree node, which
// scales poorly past a few hundred items. This webview uses lightweight
// HTML divs with on-demand expansion (children only rendered when the user
// expands a parent) and a built-in filter input.
//
// Same data source as the old tree:
//   listAssembliesInfo()                → asm → namespaces count
//   listNamespaces(asm)                 → ns → classes count
//   listClassesIn(asm, ns)              → obf class names
//
// Click on a class fires `frida.openClassDetail` with the namespace-qualified
// fullName so the Hooks plugin gets unambiguous class identity.

import * as vscode from "vscode";

import type { Profile } from "../profile";
import type { LabelKey, RpcClient } from "../types";

export class ProcessExplorerPanel {
    private panel: vscode.WebviewPanel | null = null;
    private labelChangeSub: (() => void) | null = null;
    private annotationChangeSub: (() => void) | null = null;
    private profileChangeSub: vscode.Disposable | null = null;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
        private readonly profileEvents: { onAttach: vscode.EventEmitter<Profile> },
    ) {}

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }
        this.panel = vscode.window.createWebviewPanel(
            "fridaProcessExplorer",
            "Process Explorer",
            vscode.ViewColumn.Beside,
            { enableScripts: true, retainContextWhenHidden: true },
        );
        this.panel.iconPath = new vscode.ThemeIcon("symbol-class");
        this.panel.webview.html = this.html();

        this.panel.webview.onDidReceiveMessage(async (msg: { type: string; [k: string]: unknown }) => {
            try {
                if (msg.type === "ready") {
                    await this.sendAssemblies();
                } else if (msg.type === "expandAssembly" && typeof msg.assembly === "string") {
                    await this.sendNamespaces(msg.assembly);
                } else if (msg.type === "expandNamespace" && typeof msg.assembly === "string" && typeof msg.ns === "string") {
                    await this.sendClasses(msg.assembly, msg.ns);
                } else if (msg.type === "openClass" && typeof msg.fullName === "string") {
                    await vscode.commands.executeCommand("frida.openClassDetail", msg.fullName);
                } else if (msg.type === "hookMethod" && typeof msg.fullName === "string" && typeof msg.methodName === "string") {
                    await vscode.commands.executeCommand("frida.hooks.addFromMember", msg.fullName, msg.methodName);
                }
            } catch (e) {
                const m = e instanceof Error ? e.message : String(e);
                this.panel?.webview.postMessage({ type: "error", message: m });
            }
        });

        this.panel.onDidDispose(() => this.teardown());

        // Refresh labels in the rendered tree when the user renames classes.
        const profile = this.profileSource.current();
        if (profile) {
            this.subscribeProfile(profile);
        }
        this.profileChangeSub = this.profileEvents.onAttach.event((p) => {
            this.subscribeProfile(p);
            this.panel?.webview.postMessage({ type: "reset" });
            void this.sendAssemblies();
        });
    }

    private subscribeProfile(profile: Profile): void {
        this.labelChangeSub?.();
        this.annotationChangeSub?.();
        this.labelChangeSub = profile.labels.onChange((evt) => {
            if (evt.key.kind === "class") {
                this.panel?.webview.postMessage({
                    type: "labelChange",
                    obfName: evt.key.className,
                    label: evt.newLabel,
                });
            }
        });
        this.annotationChangeSub = profile.annotations.onChange((evt) => {
            if (evt.key.kind === "class") {
                const isBookmarked = profile.annotations.isBookmarked(evt.key);
                this.panel?.webview.postMessage({
                    type: "annotationChange",
                    obfName: evt.key.className,
                    bookmarked: isBookmarked,
                    hasNote: !!profile.annotations.getNote(evt.key),
                });
            }
        });
    }

    private async sendAssemblies(): Promise<void> {
        try {
            const list = await this.rpc.call<Array<{ name: string; classes: number }>>("listAssembliesInfo");
            this.panel?.webview.postMessage({ type: "assemblies", list });
        } catch (e) {
            this.panel?.webview.postMessage({
                type: "error",
                message: `Failed to list assemblies: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    private async sendNamespaces(assembly: string): Promise<void> {
        try {
            const list = await this.rpc.call<Array<{ ns: string; classes: number }>>("listNamespaces", [assembly]);
            this.panel?.webview.postMessage({ type: "namespaces", assembly, list });
        } catch (e) {
            this.panel?.webview.postMessage({
                type: "error",
                message: `Failed to list namespaces of ${assembly}: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    private async sendClasses(assembly: string, ns: string): Promise<void> {
        try {
            const list = await this.rpc.call<string[]>("listClassesIn", [assembly, ns]);
            const profile = this.profileSource.current();
            const enriched = list.map((obf) => {
                const key: LabelKey = { kind: "class", className: obf };
                return {
                    obfName: obf,
                    fullName: ns ? `${ns}.${obf}` : obf,
                    label: profile?.labels.get(key) ?? null,
                    bookmarked: profile?.annotations.isBookmarked(key) ?? false,
                    hasNote: !!profile?.annotations.getNote(key),
                };
            });
            this.panel?.webview.postMessage({ type: "classes", assembly, ns, list: enriched });
        } catch (e) {
            this.panel?.webview.postMessage({
                type: "error",
                message: `Failed to list classes of ${assembly}/${ns}: ${e instanceof Error ? e.message : String(e)}`,
            });
        }
    }

    private teardown(): void {
        this.labelChangeSub?.();
        this.annotationChangeSub?.();
        this.profileChangeSub?.dispose();
        this.labelChangeSub = null;
        this.annotationChangeSub = null;
        this.profileChangeSub = null;
        this.panel = null;
    }

    dispose(): void {
        this.panel?.dispose();
        this.teardown();
    }

    private html(): string {
        return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
            body {
                font-family: var(--vscode-font-family);
                color: var(--vscode-foreground);
                background: var(--vscode-editor-background);
                margin: 0; padding: 0; height: 100vh; overflow: hidden;
                display: flex; flex-direction: column;
            }
            .toolbar {
                padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border);
                display: flex; gap: 6px; align-items: center;
                background: var(--vscode-editor-background);
                position: sticky; top: 0;
            }
            #filter {
                flex: 1;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
                border: 1px solid var(--vscode-input-border);
                padding: 4px 8px; border-radius: 3px;
                font-family: var(--vscode-font-family);
            }
            #filter:focus { outline: 1px solid var(--vscode-focusBorder); }
            #count { font-size: 0.85em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
            #tree {
                flex: 1; overflow-y: auto; padding: 4px 0;
            }
            .node {
                display: flex; align-items: center; gap: 4px;
                padding: 2px 4px; cursor: pointer;
                white-space: nowrap;
            }
            .node:hover { background: var(--vscode-list-hoverBackground); }
            .node.selected { background: var(--vscode-list-activeSelectionBackground); }
            .chevron {
                width: 12px; text-align: center; font-size: 0.75em;
                color: var(--vscode-descriptionForeground);
                user-select: none;
            }
            .chevron.empty { visibility: hidden; }
            .icon { width: 16px; text-align: center; }
            .label { flex: 1; }
            .count {
                font-size: 0.85em; color: var(--vscode-descriptionForeground);
                margin-left: 8px;
            }
            .label .friendly { color: var(--vscode-foreground); }
            .label .obf-tag { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 4px; }
            .badge { font-size: 0.85em; opacity: 0.8; margin-left: 4px; }
            .empty-msg { color: var(--vscode-descriptionForeground); padding: 1em; }
            .error { color: var(--vscode-errorForeground); padding: 1em; white-space: pre-wrap; }
        </style></head><body>
            <div class="toolbar">
                <input id="filter" placeholder="Filter assemblies, namespaces, classes — substring, case-insensitive">
                <span id="count"></span>
            </div>
            <div id="tree"><div class="empty-msg">Loading…</div></div>
            <script>
                const vscode = acquireVsCodeApi();
                const tree = document.getElementById("tree");
                const countEl = document.getElementById("count");
                const filterInput = document.getElementById("filter");

                // Internal state — flat list of "rendered" rows. Each item carries
                // its kind/parent path so filtering can match against full path.
                /** @type {{el:HTMLElement, kind:string, asm:string, ns?:string, obfName?:string, label?:string|null, fullName?:string, expanded?:boolean}[]} */
                const rows = [];
                /** @type {Map<string, {assembly:string, list:any[]}>} cache for ns lists */
                const nsCache = new Map();
                /** @type {Map<string, {assembly:string, ns:string, list:any[]}>} cache for class lists */
                const classCache = new Map();

                function escape(s) {
                    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
                }

                function renderAssembly(a) {
                    const el = document.createElement("div");
                    el.className = "node assembly";
                    el.dataset.assembly = a.name;
                    el.dataset.expanded = "false";
                    el.innerHTML =
                        '<span class="chevron">▶</span>' +
                        '<span class="icon">📦</span>' +
                        '<span class="label">' + escape(a.name) + '</span>' +
                        '<span class="count">(' + a.classes + ')</span>';
                    el.addEventListener("click", () => toggleAssembly(el, a.name));
                    return el;
                }

                function renderNamespace(asm, n, indent) {
                    const el = document.createElement("div");
                    el.className = "node namespace";
                    el.dataset.assembly = asm;
                    el.dataset.ns = n.ns;
                    el.dataset.expanded = "false";
                    el.style.paddingLeft = (indent * 16) + "px";
                    el.innerHTML =
                        '<span class="chevron">▶</span>' +
                        '<span class="icon">📁</span>' +
                        '<span class="label">' + escape(n.ns || "(root)") + '</span>' +
                        '<span class="count">(' + n.classes + ')</span>';
                    el.addEventListener("click", () => toggleNamespace(el, asm, n.ns));
                    return el;
                }

                function renderClass(asm, ns, c, indent) {
                    const el = document.createElement("div");
                    el.className = "node class";
                    el.dataset.assembly = asm;
                    el.dataset.ns = ns;
                    el.dataset.obf = c.obfName;
                    el.dataset.fullname = c.fullName;
                    el.style.paddingLeft = (indent * 16) + "px";
                    let labelHtml = c.label
                        ? '<span class="friendly">' + escape(c.label) + '</span><span class="obf-tag">[' + escape(c.obfName) + ']</span>'
                        : escape(c.obfName);
                    let badges = "";
                    if (c.bookmarked) badges += '<span class="badge">⭐</span>';
                    if (c.hasNote) badges += '<span class="badge">📝</span>';
                    el.innerHTML =
                        '<span class="chevron empty">·</span>' +
                        '<span class="icon">🔷</span>' +
                        '<span class="label">' + labelHtml + badges + '</span>';
                    el.addEventListener("click", () => {
                        vscode.postMessage({ type: "openClass", fullName: c.fullName });
                    });
                    el.addEventListener("contextmenu", (ev) => {
                        ev.preventDefault();
                        // Right-click: minimal — just open the class detail (where Hook button lives).
                        vscode.postMessage({ type: "openClass", fullName: c.fullName });
                    });
                    return el;
                }

                function toggleAssembly(el, asm) {
                    if (el.dataset.expanded === "true") {
                        // collapse: remove children that follow until next assembly or end
                        let next = el.nextElementSibling;
                        while (next && !next.classList.contains("assembly")) {
                            const toRemove = next;
                            next = next.nextElementSibling;
                            toRemove.remove();
                        }
                        el.dataset.expanded = "false";
                        el.querySelector(".chevron").textContent = "▶";
                    } else {
                        const cached = nsCache.get(asm);
                        if (cached) {
                            renderNamespacesAfter(el, asm, cached.list);
                        } else {
                            vscode.postMessage({ type: "expandAssembly", assembly: asm });
                        }
                        el.dataset.expanded = "true";
                        el.querySelector(".chevron").textContent = "▼";
                    }
                }

                function renderNamespacesAfter(asmEl, asm, list) {
                    const frag = document.createDocumentFragment();
                    for (const n of list) {
                        const nsEl = renderNamespace(asm, n, 1);
                        frag.appendChild(nsEl);
                    }
                    asmEl.after(frag);
                    applyFilter();
                }

                function toggleNamespace(el, asm, ns) {
                    if (el.dataset.expanded === "true") {
                        // collapse: remove following deeper-indented siblings
                        const indent = parseInt(el.style.paddingLeft || "0", 10);
                        let next = el.nextElementSibling;
                        while (next && parseInt(next.style.paddingLeft || "0", 10) > indent) {
                            const toRemove = next;
                            next = next.nextElementSibling;
                            toRemove.remove();
                        }
                        el.dataset.expanded = "false";
                        el.querySelector(".chevron").textContent = "▶";
                    } else {
                        const key = asm + "::" + ns;
                        const cached = classCache.get(key);
                        if (cached) {
                            renderClassesAfter(el, asm, ns, cached.list);
                        } else {
                            vscode.postMessage({ type: "expandNamespace", assembly: asm, ns: ns });
                        }
                        el.dataset.expanded = "true";
                        el.querySelector(".chevron").textContent = "▼";
                    }
                }

                function renderClassesAfter(nsEl, asm, ns, list) {
                    const frag = document.createDocumentFragment();
                    for (const c of list) {
                        frag.appendChild(renderClass(asm, ns, c, 2));
                    }
                    nsEl.after(frag);
                    applyFilter();
                }

                function applyFilter() {
                    const q = filterInput.value.toLowerCase();
                    if (!q) {
                        for (const el of tree.querySelectorAll(".node")) el.style.display = "";
                        countEl.textContent = "";
                        return;
                    }
                    let shown = 0;
                    for (const el of tree.querySelectorAll(".node")) {
                        const lbl = el.querySelector(".label") ? el.querySelector(".label").textContent.toLowerCase() : "";
                        const visible = lbl.includes(q);
                        el.style.display = visible ? "" : "none";
                        if (visible) shown++;
                    }
                    countEl.textContent = shown + " match" + (shown === 1 ? "" : "es");
                }

                filterInput.addEventListener("input", applyFilter);

                window.addEventListener("message", (msg) => {
                    const m = msg.data;
                    if (m.type === "assemblies") {
                        tree.innerHTML = "";
                        if (!m.list || m.list.length === 0) {
                            tree.innerHTML = '<div class="empty-msg">No assemblies. Attach Frida first.</div>';
                            return;
                        }
                        const frag = document.createDocumentFragment();
                        for (const a of m.list) frag.appendChild(renderAssembly(a));
                        tree.appendChild(frag);
                        applyFilter();
                    } else if (m.type === "namespaces") {
                        nsCache.set(m.assembly, { assembly: m.assembly, list: m.list });
                        const asmEl = tree.querySelector('.node.assembly[data-assembly="' + cssEscape(m.assembly) + '"]');
                        if (asmEl) renderNamespacesAfter(asmEl, m.assembly, m.list);
                    } else if (m.type === "classes") {
                        classCache.set(m.assembly + "::" + m.ns, { assembly: m.assembly, ns: m.ns, list: m.list });
                        const sel = '.node.namespace[data-assembly="' + cssEscape(m.assembly) + '"][data-ns="' + cssEscape(m.ns) + '"]';
                        const nsEl = tree.querySelector(sel);
                        if (nsEl) renderClassesAfter(nsEl, m.assembly, m.ns, m.list);
                    } else if (m.type === "labelChange") {
                        // Re-render any class node matching obfName.
                        for (const el of tree.querySelectorAll('.node.class[data-obf="' + cssEscape(m.obfName) + '"]')) {
                            const labelEl = el.querySelector(".label");
                            const obf = el.dataset.obf;
                            if (m.label) {
                                labelEl.innerHTML = '<span class="friendly">' + escape(m.label) + '</span>' +
                                    '<span class="obf-tag">[' + escape(obf) + ']</span>';
                            } else {
                                labelEl.innerHTML = escape(obf);
                            }
                        }
                    } else if (m.type === "annotationChange") {
                        for (const el of tree.querySelectorAll('.node.class[data-obf="' + cssEscape(m.obfName) + '"]')) {
                            // Just re-fetch from cache and re-render (simplest).
                            const labelEl = el.querySelector(".label");
                            const friendlyEl = labelEl.querySelector(".friendly");
                            const friendly = friendlyEl ? friendlyEl.textContent : null;
                            const obf = el.dataset.obf;
                            let html = friendly
                                ? '<span class="friendly">' + escape(friendly) + '</span><span class="obf-tag">[' + escape(obf) + ']</span>'
                                : escape(obf);
                            if (m.bookmarked) html += '<span class="badge">⭐</span>';
                            if (m.hasNote) html += '<span class="badge">📝</span>';
                            labelEl.innerHTML = html;
                        }
                    } else if (m.type === "reset") {
                        tree.innerHTML = '<div class="empty-msg">Loading…</div>';
                        nsCache.clear();
                        classCache.clear();
                    } else if (m.type === "error") {
                        tree.innerHTML = '<div class="error">' + escape(m.message) + '</div>';
                    }
                });

                function cssEscape(s) {
                    // Minimal escape for attribute selectors. Replace " with \\".
                    return String(s).replace(/"/g, '\\\\"').replace(/\\\\/g, "\\\\\\\\");
                }

                // Signal ready so host sends initial assemblies list.
                vscode.postMessage({ type: "ready" });
            </script>
        </body></html>`;
    }
}
