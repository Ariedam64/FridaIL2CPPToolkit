// Webview that renders class detail (fields, methods) with structured syntax-
// highlighted HTML. Actions: rename, bookmark, add-note, copy-obf. Each method
// row has an inline Hook button that fires frida.hooks.addFromMember.

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

    panel.webview.onDidReceiveMessage(async (msg: { type: string; payload?: unknown; methodName?: string }) => {
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
            case "hookMethod":
                if (typeof msg.methodName === "string") {
                    await vscode.commands.executeCommand("frida.hooks.addFromMember", obfClassName, msg.methodName);
                }
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

// ---------------------------------------------------------------------------
// Dump parser
// ---------------------------------------------------------------------------

interface FieldEntry  { isStatic: boolean; typeName: string; fieldName: string }
interface MethodEntry { isStatic: boolean; returnType: string; methodName: string; params: string }

interface ParsedDump {
    className: string;
    fields: FieldEntry[];
    methods: MethodEntry[];
}

/**
 * Parse the markdown produced by dumpClassAsString:
 *
 *   # ClassName
 *
 *   **Fields (N)**
 *
 *   - static? TypeName FieldName
 *
 *   **Methods (N)**
 *
 *   - static? ReturnType MethodName(ParamType ParamName, ...)
 */
function parseDump(dump: string): ParsedDump {
    const lines = dump.split("\n");
    let className = "";
    const fields: FieldEntry[] = [];
    const methods: MethodEntry[] = [];

    // Regex: optional "static ", then ReturnType, then MethodName(params)
    const methodRe = /^(static\s+)?(\S+)\s+(\w+)\((.*)\)$/;
    // Field: optional "static ", then TypeName, then FieldName (no parens at end)
    const fieldRe  = /^(static\s+)?(\S+)\s+(\S+)$/;

    let section: "none" | "fields" | "methods" = "none";

    for (const raw of lines) {
        const line = raw.trim();

        if (line.startsWith("# ")) {
            className = line.slice(2).trim();
            continue;
        }
        if (line.startsWith("**Fields")) {
            section = "fields";
            continue;
        }
        if (line.startsWith("**Methods")) {
            section = "methods";
            continue;
        }
        if (!line.startsWith("- ")) continue;

        const body = line.slice(2); // strip leading "- "

        if (section === "fields") {
            const m = fieldRe.exec(body);
            if (m) {
                fields.push({
                    isStatic:  !!m[1],
                    typeName:  m[2],
                    fieldName: m[3],
                });
            } else {
                // Fallback: store raw
                fields.push({ isStatic: false, typeName: body, fieldName: "" });
            }
        } else if (section === "methods") {
            const m = methodRe.exec(body);
            if (m) {
                methods.push({
                    isStatic:   !!m[1],
                    returnType: m[2],
                    methodName: m[3],
                    params:     m[4],
                });
            } else {
                // Generic type / nested parens edge case — store raw method name
                // by pulling the identifier before the first '('
                const parenIdx = body.indexOf("(");
                if (parenIdx > 0) {
                    const beforeParen = body.slice(0, parenIdx).trim();
                    const parts = beforeParen.split(/\s+/);
                    const mName = parts.pop() ?? "";
                    const retParts = parts.filter(p => p !== "static");
                    methods.push({
                        isStatic:   body.startsWith("static "),
                        returnType: retParts.join(" ") || "?",
                        methodName: mName,
                        params:     body.slice(parenIdx + 1, body.lastIndexOf(")")) || "",
                    });
                } else {
                    // Completely unrecognised line — emit as-is with empty params
                    methods.push({ isStatic: false, returnType: "", methodName: body, params: "" });
                }
            }
        }
    }

    return { className, fields, methods };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderClass(obf: string, dump: string, profile: Profile | null): string {
    const labelKey: LabelKey = { kind: "class", className: obf };
    const friendly    = profile?.labels.get(labelKey) ?? null;
    const display     = friendly ?? obf;
    const isBookmarked = profile?.annotations.isBookmarked(labelKey) ?? false;
    const note        = profile?.annotations.getNote(labelKey) ?? null;

    const parsed = parseDump(dump);

    const fieldsHtml  = parsed.fields.map(renderField).join("\n");
    const methodsHtml = parsed.methods.map(renderMethod).join("\n");

    const titleHtml = friendly
        ? `${escHtml(display)} <span class="obf-tag">[${escHtml(obf)}]</span>`
        : escHtml(display);

    const noteHtml = note
        ? `<div class="note">${escHtml(note).replace(/\n/g, "<br>")}</div>`
        : "";

    return /* html */ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body {
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size, 13px);
            padding: 1rem;
            color: var(--vscode-editor-foreground);
            background: var(--vscode-editor-background);
            line-height: 1.6;
        }
        h2 { color: var(--vscode-textLink-foreground); margin-bottom: 0.25em; }
        .obf-tag { font-size: 0.82em; color: var(--vscode-descriptionForeground); font-weight: normal; }
        .note {
            background: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textBlockQuote-border);
            padding: 0.6rem 0.8rem; margin: 0.8rem 0; font-style: italic;
        }
        .actions { margin: 0.6rem 0 1rem 0; display: flex; flex-wrap: wrap; gap: 0.4rem; }
        .actions button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none; padding: 0.35rem 0.75rem; border-radius: 2px; cursor: pointer;
        }
        .actions button:hover { background: var(--vscode-button-hoverBackground); }
        .actions button.active {
            background: var(--vscode-statusBarItem-warningBackground);
            color: var(--vscode-statusBarItem-warningForeground);
        }
        .section-title {
            font-weight: bold; margin: 1.2em 0 0.3em 0;
            color: var(--vscode-textLink-foreground);
            font-size: 1em;
        }
        .member-list { list-style: none; margin: 0; padding: 0; }
        .field, .method {
            display: flex; align-items: center; gap: 0.45em;
            padding: 1px 0;
            font-family: var(--vscode-editor-font-family);
            font-size: var(--vscode-editor-font-size, 13px);
        }
        .static-badge { color: var(--vscode-debugTokenExpression-string); font-style: italic; font-size: 0.9em; }
        .type-name    { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
        .member-name  { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); font-weight: 600; }
        .params       { color: var(--vscode-descriptionForeground); }
        .hook-btn {
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border: none; padding: 1px 7px; border-radius: 3px; cursor: pointer;
            font-size: 0.82em; margin-left: 0.3em; white-space: nowrap;
        }
        .hook-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
        hr { border: none; border-top: 1px solid var(--vscode-panel-border, #333); margin: 0.6rem 0; }
    </style></head><body>
        <h2>${titleHtml}</h2>
        <div class="actions">
            <button onclick="post('rename')">Rename</button>
            <button class="${isBookmarked ? "active" : ""}" onclick="post('bookmark')">${isBookmarked ? "&#9733; Bookmarked" : "&#9734; Bookmark"}</button>
            <button onclick="post('addNote')">${note ? "Edit note" : "Add note"}</button>
            <button onclick="post('copyObf')">Copy obf</button>
        </div>
        ${noteHtml}
        <div class="section-title">Fields (${parsed.fields.length})</div>
        <hr>
        <ul class="member-list">
${fieldsHtml}
        </ul>
        <div class="section-title">Methods (${parsed.methods.length})</div>
        <hr>
        <ul class="member-list">
${methodsHtml}
        </ul>
        <script>
            const vscode = acquireVsCodeApi();
            function post(type, extra) { vscode.postMessage(Object.assign({ type }, extra)); }
            document.addEventListener("click", function(e) {
                const btn = e.target && e.target.closest && e.target.closest(".hook-btn");
                if (btn) {
                    post("hookMethod", { methodName: btn.dataset.method });
                }
            });
        </script>
    </body></html>`;
}

function renderField(f: FieldEntry): string {
    const staticBadge = f.isStatic ? `<span class="static-badge">static</span> ` : "";
    const typePart    = f.typeName  ? `<span class="type-name">${escHtml(f.typeName)}</span>` : "";
    const namePart    = f.fieldName ? `<span class="member-name">${escHtml(f.fieldName)}</span>` : "";
    return `            <li class="field">${staticBadge}${typePart} ${namePart}</li>`;
}

function renderMethod(m: MethodEntry): string {
    const staticBadge = m.isStatic ? `<span class="static-badge">static</span> ` : "";
    const retPart     = m.returnType ? `<span class="type-name">${escHtml(m.returnType)}</span>` : "";
    const namePart    = m.methodName ? `<span class="member-name">${escHtml(m.methodName)}</span>` : "";
    const paramPart   = `<span class="params">(${escHtml(m.params)})</span>`;
    // Encode the method name for the data attribute
    const dataMethod  = escAttr(m.methodName);
    const hookBtn     = `<button class="hook-btn" data-method="${dataMethod}">&#x1FA9D; Hook</button>`;
    return `            <li class="method">${staticBadge}${retPart} ${namePart}${paramPart}${hookBtn}</li>`;
}

function renderError(obf: string, msg: string): string {
    return /* html */ `<!DOCTYPE html><html><body style="font-family: var(--vscode-editor-font-family); padding: 1rem;">
        <h2>${escHtml(obf)}</h2>
        <p>RPC failed:</p><pre style="color: var(--vscode-errorForeground);">${escHtml(msg)}</pre>
    </body></html>`;
}

function escHtml(s: string): string {
    return s
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function escAttr(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
