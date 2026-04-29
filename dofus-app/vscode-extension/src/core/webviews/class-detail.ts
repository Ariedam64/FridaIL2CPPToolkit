// Webview that renders class detail (fields, methods, parents) with rename
// + bookmark + add-note actions. Reacts to label/annotation events via a
// disposable subscription.

import * as vscode from "vscode";

import type { Profile } from "../profile";
import type { LabelKey, RpcClient } from "../types";

export async function openClassDetail(
    obfClassName: string,
    rpc: RpcClient,
    profileSource: { current(): Profile | null },
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        "fridaClassDetail",
        `Class: ${obfClassName}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon("symbol-class");

    let dump = "";
    try {
        dump = await rpc.call<string>("dumpClassAsString", [obfClassName]);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        panel.webview.html = renderError(obfClassName, msg);
        return;
    }

    const render = (): void => {
        const profile = profileSource.current();
        panel.title = `Class: ${profile?.labels.display({ kind: "class", className: obfClassName }) ?? obfClassName}`;
        panel.webview.html = renderClass(obfClassName, dump, profile);
    };
    render();

    panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown }) => {
        switch (msg.type) {
            case "rename":
                await vscode.commands.executeCommand("frida.renameClass", obfClassName);
                render();
                break;
            case "bookmark":
                await vscode.commands.executeCommand("frida.toggleBookmark", obfClassName);
                render();
                break;
            case "addNote":
                await vscode.commands.executeCommand("frida.addNote", obfClassName);
                render();
                break;
            case "copyObf":
                await vscode.env.clipboard.writeText(obfClassName);
                vscode.window.showInformationMessage(`Copied: ${obfClassName}`);
                break;
        }
    });

    const profile = profileSource.current();
    if (profile) {
        const offLabel = profile.labels.onChange((e) => {
            if (matchesClass(e.key, obfClassName)) render();
        });
        const offAnn = profile.annotations.onChange((e) => {
            if (matchesClass(e.key, obfClassName)) render();
        });
        panel.onDidDispose(() => { offLabel(); offAnn(); });
    }
}

function matchesClass(k: LabelKey, className: string): boolean {
    return (k.kind === "class" && k.className === className)
        || (k.kind === "method" && k.className === className)
        || (k.kind === "field" && k.className === className);
}

function renderClass(obf: string, dump: string, profile: Profile | null): string {
    const labelKey: LabelKey = { kind: "class", className: obf };
    const friendly = profile?.labels.get(labelKey) ?? null;
    const display = friendly ?? obf;
    const isBookmarked = profile?.annotations.isBookmarked(labelKey) ?? false;
    const note = profile?.annotations.getNote(labelKey) ?? null;

    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body { font-family: var(--vscode-editor-font-family); padding: 1rem;
            color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); line-height: 1.5; }
        h2 { color: var(--vscode-textLink-foreground); margin-bottom: 0.25em; }
        .obf-tag { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        .note { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 0.6rem 0.8rem; margin: 1rem 0; font-style: italic; }
        pre { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 0.6rem; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 0.4rem 0.8rem; border-radius: 2px; cursor: pointer; margin-right: 0.5rem; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        button.active { background: var(--vscode-statusBarItem-warningBackground); color: var(--vscode-statusBarItem-warningForeground); }
    </style></head><body>
        <h2>${escapeHtml(display)} ${friendly ? `<span class="obf-tag">[${escapeHtml(obf)}]</span>` : ""}</h2>
        <div>
            <button onclick="vscode.postMessage({type:'rename'})">Rename</button>
            <button class="${isBookmarked ? "active" : ""}" onclick="vscode.postMessage({type:'bookmark'})">${isBookmarked ? "★ Bookmarked" : "☆ Bookmark"}</button>
            <button onclick="vscode.postMessage({type:'addNote'})">${note ? "Edit note" : "Add note"}</button>
            <button onclick="vscode.postMessage({type:'copyObf'})">Copy obf</button>
        </div>
        ${note ? `<div class="note">${escapeHtml(note).replace(/\n/g, "<br>")}</div>` : ""}
        <pre>${escapeHtml(dump)}</pre>
        <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

function renderError(obf: string, msg: string): string {
    return /*html*/ `<!DOCTYPE html><html><body style="font-family: var(--vscode-editor-font-family); padding: 1rem;">
        <h2>${escapeHtml(obf)}</h2>
        <p>RPC failed:</p><pre style="color: var(--vscode-errorForeground);">${escapeHtml(msg)}</pre>
    </body></html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
