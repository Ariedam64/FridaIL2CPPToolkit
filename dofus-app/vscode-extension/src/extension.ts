// Frida IL2CPP Toolkit — minimal VSCode extension demo
//
// Connects to the existing Frida RPC agent (default localhost:3001/api/call)
// and exposes:
//   - Tree view "Process Explorer" listing assemblies → classes (via listAssembliesInfo / listClassesIn)
//   - Tree view "Active Hooks" (placeholder, hook lifecycle to be wired)
//   - Status bar item with attached process state
//   - Commands: search class, rename class, dump class, toggle obf names, refresh
//   - Webview opened when clicking a class with its detail (dumpClassAsString)
//
// Renames are persisted in-memory for this demo. In a real version they'd live
// in a labels.json profile keyed by build-guid.

import * as vscode from "vscode";
import * as http from "http";

// ---------------------------------------------------------------------------
// Frida RPC client
// ---------------------------------------------------------------------------

interface RpcResponse<T = unknown> {
    result?: T;
    error?: string;
}

function rpcCall<T = unknown>(method: string, args: unknown[] = []): Promise<T> {
    const endpoint = vscode.workspace
        .getConfiguration("fridaToolkit")
        .get<string>("rpcEndpoint", "http://localhost:3001/api/call");
    const url = new URL(endpoint);
    const body = JSON.stringify({ method, args });
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: url.hostname,
                port: parseInt(url.port || "80", 10),
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: 30_000,
            },
            (res) => {
                let chunks = "";
                res.on("data", (c) => (chunks += c));
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(chunks) as RpcResponse<T>;
                        if (parsed.error) {
                            reject(new Error(parsed.error));
                        } else {
                            resolve(parsed.result as T);
                        }
                    } catch (e) {
                        reject(e instanceof Error ? e : new Error(String(e)));
                    }
                });
            }
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("RPC timeout")));
        req.write(body);
        req.end();
    });
}

// ---------------------------------------------------------------------------
// Label store (in-memory for demo; production would persist to disk)
// ---------------------------------------------------------------------------

const labels = new Map<string, string>(); // obf -> friendly
let showObfNames = false;

function display(obfName: string): string {
    const friendly = labels.get(obfName);
    if (!friendly) return obfName;
    return showObfNames ? `${friendly} [${obfName}]` : friendly;
}

// ---------------------------------------------------------------------------
// Tree: Process Explorer
// ---------------------------------------------------------------------------

type ExplorerNode =
    | { kind: "assembly"; name: string; classCount: number }
    | { kind: "namespace"; assembly: string; ns: string; classCount: number }
    | { kind: "class"; assembly: string; ns: string; obfName: string };

class ProcessExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        switch (node.kind) {
            case "assembly": {
                const item = new vscode.TreeItem(
                    `${node.name} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.iconPath = new vscode.ThemeIcon("package");
                item.contextValue = "assembly";
                return item;
            }
            case "namespace": {
                const label = node.ns || "(root)";
                const item = new vscode.TreeItem(
                    `${label} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                item.iconPath = new vscode.ThemeIcon("symbol-namespace");
                item.contextValue = "namespace";
                return item;
            }
            case "class": {
                const item = new vscode.TreeItem(
                    display(node.obfName),
                    vscode.TreeItemCollapsibleState.None
                );
                item.iconPath = new vscode.ThemeIcon("symbol-class");
                item.tooltip = node.obfName + (labels.has(node.obfName) ? ` (obf)` : "");
                item.contextValue = "class";
                item.command = {
                    command: "frida.dumpClass",
                    title: "Dump class",
                    arguments: [node.obfName],
                };
                return item;
            }
        }
    }

    async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
        try {
            if (!node) {
                const list = await rpcCall<Array<{ name: string; classes: number }>>(
                    "listAssembliesInfo"
                );
                return list.map((a) => ({
                    kind: "assembly",
                    name: a.name,
                    classCount: a.classes,
                }));
            }
            if (node.kind === "assembly") {
                const list = await rpcCall<Array<{ ns: string; classes: number }>>(
                    "listNamespaces",
                    [node.name]
                );
                return list.map((nsInfo) => ({
                    kind: "namespace",
                    assembly: node.name,
                    ns: nsInfo.ns,
                    classCount: nsInfo.classes,
                }));
            }
            if (node.kind === "namespace") {
                const list = await rpcCall<string[]>("listClassesIn", [
                    node.assembly,
                    node.ns,
                ]);
                return list.map((obfName) => ({
                    kind: "class",
                    assembly: node.assembly,
                    ns: node.ns,
                    obfName,
                }));
            }
            return [];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida RPC error: ${msg}`);
            return [];
        }
    }
}

// ---------------------------------------------------------------------------
// Tree: Active Hooks (placeholder for demo)
// ---------------------------------------------------------------------------

interface ActiveHook {
    id: string;
    targetClass: string;
    method: string;
    hits: number;
}

class ActiveHooksProvider implements vscode.TreeDataProvider<ActiveHook> {
    private _onDidChangeTreeData = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    private hooks: ActiveHook[] = [];

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    setHooks(hooks: ActiveHook[]): void {
        this.hooks = hooks;
        this.refresh();
    }

    getTreeItem(hook: ActiveHook): vscode.TreeItem {
        const item = new vscode.TreeItem(
            `${display(hook.targetClass)}.${hook.method}`,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = `${hook.hits} hits`;
        item.iconPath = new vscode.ThemeIcon("debug-disconnect");
        item.tooltip = `Hook id: ${hook.id}`;
        return item;
    }

    getChildren(): ActiveHook[] {
        return this.hooks;
    }
}

// ---------------------------------------------------------------------------
// Webview: class detail
// ---------------------------------------------------------------------------

async function openClassWebview(context: vscode.ExtensionContext, obfName: string) {
    const panel = vscode.window.createWebviewPanel(
        "fridaClassDetail",
        `Class: ${display(obfName)}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.iconPath = new vscode.ThemeIcon("symbol-class");
    panel.webview.html = renderClassWebviewLoading(obfName);
    try {
        const detail = await rpcCall<string>("dumpClassAsString", [obfName]);
        panel.webview.html = renderClassWebview(obfName, detail);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderClassWebviewError(obfName, msg);
    }
}

function renderClassWebviewLoading(obfName: string): string {
    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>
            body { font-family: var(--vscode-editor-font-family); padding: 1rem; color: var(--vscode-editor-foreground); }
            .loading { opacity: 0.6; font-style: italic; }
        </style></head>
        <body>
            <h2>${escapeHtml(display(obfName))}</h2>
            <p class="loading">Loading from Frida agent...</p>
        </body></html>`;
}

function renderClassWebviewError(obfName: string, msg: string): string {
    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>
            body { font-family: var(--vscode-editor-font-family); padding: 1rem; }
            .err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
        </style></head>
        <body>
            <h2>${escapeHtml(display(obfName))}</h2>
            <p>RPC call failed:</p>
            <pre class="err">${escapeHtml(msg)}</pre>
        </body></html>`;
}

function renderClassWebview(obfName: string, body: string): string {
    const display_name = display(obfName);
    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8">
        <style>
            body {
                font-family: var(--vscode-editor-font-family);
                font-size: var(--vscode-editor-font-size);
                color: var(--vscode-editor-foreground);
                background: var(--vscode-editor-background);
                padding: 1rem;
                line-height: 1.5;
            }
            h2 { color: var(--vscode-textLink-foreground); }
            pre {
                background: var(--vscode-textBlockQuote-background);
                border-left: 3px solid var(--vscode-textBlockQuote-border);
                padding: 0.75rem;
                overflow-x: auto;
                white-space: pre-wrap;
                word-break: break-word;
            }
            .obf-tag {
                font-size: 0.85em;
                color: var(--vscode-descriptionForeground);
                font-family: var(--vscode-editor-font-family);
            }
            button {
                background: var(--vscode-button-background);
                color: var(--vscode-button-foreground);
                border: none;
                padding: 0.4rem 0.8rem;
                border-radius: 2px;
                cursor: pointer;
                margin-right: 0.5rem;
            }
            button:hover { background: var(--vscode-button-hoverBackground); }
        </style></head>
        <body>
            <h2>${escapeHtml(display_name)} <span class="obf-tag">[${escapeHtml(obfName)}]</span></h2>
            <div>
                <button onclick="vscode.postMessage({type:'rename'})">Rename</button>
                <button onclick="vscode.postMessage({type:'addNote'})">Add note</button>
                <button onclick="vscode.postMessage({type:'bookmark'})">Bookmark</button>
            </div>
            <pre>${escapeHtml(body)}</pre>
            <script>const vscode = acquireVsCodeApi();</script>
        </body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

class StatusBarController {
    private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

    constructor() {
        this.item.command = "frida.refreshExplorer";
        this.setDisconnected();
        this.item.show();
    }

    setDisconnected(): void {
        this.item.text = `$(circle-slash) Frida: not connected`;
        this.item.tooltip = "Frida RPC unreachable. Check rpcEndpoint setting.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    setConnected(processName: string, classes: number): void {
        this.item.text = `$(zap) ${processName} | ${classes} classes`;
        this.item.tooltip = `Connected to Frida RPC. ${classes} classes indexed. Click to refresh.`;
        this.item.backgroundColor = undefined;
    }

    dispose(): void {
        this.item.dispose();
    }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export async function activate(context: vscode.ExtensionContext) {
    const explorerProvider = new ProcessExplorerProvider();
    const hooksProvider = new ActiveHooksProvider();
    const statusBar = new StatusBarController();

    vscode.window.registerTreeDataProvider("fridaProcessExplorer", explorerProvider);
    vscode.window.registerTreeDataProvider("fridaActiveHooks", hooksProvider);

    // ---- Health check / status bar refresh ----
    async function updateStatus() {
        try {
            const list = await rpcCall<Array<{ name: string; classes: number }>>(
                "listAssembliesInfo"
            );
            const total = list.reduce((acc, a) => acc + a.classes, 0);
            statusBar.setConnected("attached", total);
        } catch {
            statusBar.setDisconnected();
        }
    }
    updateStatus();
    const interval = setInterval(updateStatus, 10_000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });

    // ---- Commands ----
    context.subscriptions.push(
        vscode.commands.registerCommand("frida.refreshExplorer", () => {
            explorerProvider.refresh();
            hooksProvider.refresh();
            updateStatus();
        }),

        vscode.commands.registerCommand("frida.searchClass", async () => {
            const input = await vscode.window.showInputBox({
                prompt: "Search class (obfuscated or label)",
                placeHolder: "egq, HaapiService, Map*, ...",
            });
            if (!input) return;
            try {
                // Try direct dump first; fallback to a search RPC if available
                const detail = await rpcCall<string>("dumpClassAsString", [input]).catch(
                    () => null
                );
                if (detail) {
                    openClassWebview(context, input);
                    return;
                }
                vscode.window.showInformationMessage(
                    `No class matching "${input}" — try a partial match RPC if available.`
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`Search failed: ${msg}`);
            }
        }),

        vscode.commands.registerCommand(
            "frida.dumpClass",
            async (obfName: string | undefined) => {
                const target =
                    obfName ??
                    (await vscode.window.showInputBox({
                        prompt: "Class obf name to dump",
                    }));
                if (!target) return;
                openClassWebview(context, target);
            }
        ),

        vscode.commands.registerCommand("frida.renameClass", async () => {
            const obf = await vscode.window.showInputBox({ prompt: "Obfuscated name" });
            if (!obf) return;
            const friendly = await vscode.window.showInputBox({
                prompt: `New label for "${obf}"`,
                value: labels.get(obf) ?? "",
            });
            if (friendly === undefined) return;
            if (friendly === "") {
                labels.delete(obf);
                vscode.window.showInformationMessage(`Removed label for ${obf}`);
            } else {
                labels.set(obf, friendly);
                vscode.window.showInformationMessage(`${obf} → ${friendly}`);
            }
            explorerProvider.refresh();
            hooksProvider.refresh();
        }),

        vscode.commands.registerCommand("frida.toggleObfNames", () => {
            showObfNames = !showObfNames;
            vscode.window.showInformationMessage(
                showObfNames ? "Showing obf alongside labels" : "Hiding obf names"
            );
            explorerProvider.refresh();
            hooksProvider.refresh();
        })
    );

    context.subscriptions.push(statusBar);
}

export function deactivate() {}
