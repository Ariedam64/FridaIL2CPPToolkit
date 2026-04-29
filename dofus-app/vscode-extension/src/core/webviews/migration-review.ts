// Webview to review a single migration candidate. Shows old fingerprint
// vs. candidate fingerprint side by side with Accept / Reject buttons.

import * as vscode from "vscode";

import type { ClassFingerprint } from "../types";

export interface MigrationReviewInput {
    oldObf: string;
    label: string;
    oldFingerprint: ClassFingerprint;
    candidates: Array<{ newObf: string; score: number; fingerprint: ClassFingerprint; reason: string }>;
}

export async function openMigrationReview(
    input: MigrationReviewInput,
    onAccept: (newObf: string) => void,
    onReject: () => void,
): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
        "fridaMigrationReview",
        `Migration: ${input.label}`,
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.webview.html = render(input);

    panel.webview.onDidReceiveMessage((msg: { type: string; newObf?: string }) => {
        if (msg.type === "accept" && msg.newObf) {
            onAccept(msg.newObf);
            panel.dispose();
        } else if (msg.type === "reject") {
            onReject();
            panel.dispose();
        }
    });
}

function render(input: MigrationReviewInput): string {
    return /*html*/ `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body { font-family: var(--vscode-editor-font-family); padding: 1rem;
            color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); }
        h2 { color: var(--vscode-textLink-foreground); }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin: 1rem 0; }
        .col { background: var(--vscode-textBlockQuote-background); padding: 1rem; border-radius: 4px; }
        .candidate { border-left: 3px solid var(--vscode-statusBarItem-warningBackground); margin: 0.5rem 0; padding: 0.5rem; }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
            border: none; padding: 0.4rem 0.8rem; border-radius: 2px; cursor: pointer; margin-right: 0.5rem; }
        button.reject { background: var(--vscode-errorForeground); color: white; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        ul { font-size: 0.9em; padding-left: 1.2em; }
    </style></head><body>
        <h2>Migration: ${escapeHtml(input.label)}</h2>
        <p>Old obf: <code>${escapeHtml(input.oldObf)}</code></p>
        <h3>Candidates (sorted by score)</h3>
        ${input.candidates.map((c) => `
            <div class="candidate">
                <strong>${escapeHtml(c.newObf)}</strong> &mdash; score ${c.score.toFixed(3)}
                <p>${escapeHtml(c.reason)}</p>
                <div class="grid">
                    <div class="col">
                        <h4>Old fingerprint</h4>
                        ${renderFingerprint(input.oldFingerprint)}
                    </div>
                    <div class="col">
                        <h4>Candidate fingerprint</h4>
                        ${renderFingerprint(c.fingerprint)}
                    </div>
                </div>
                <button onclick="vscode.postMessage({type:'accept', newObf:'${escapeHtml(c.newObf)}'})">Accept this</button>
            </div>
        `).join("")}
        <button class="reject" onclick="vscode.postMessage({type:'reject'})">Reject all (mark as lost)</button>
        <script>const vscode = acquireVsCodeApi();</script>
    </body></html>`;
}

function renderFingerprint(fp: ClassFingerprint): string {
    return `
        <ul>
            <li>token: <code>${fp.token ?? "(none)"}</code></li>
            <li>parents: ${fp.parents.map(escapeHtml).join(", ") || "(none)"}</li>
            <li>methods: ${fp.methodCount}</li>
            <li>fields: ${fp.fieldTypes.length}</li>
        </ul>
        <details><summary>method signatures (${fp.methodSignatures.length})</summary>
            <ul>${fp.methodSignatures.slice(0, 20).map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join("")}
            ${fp.methodSignatures.length > 20 ? `<li>... (${fp.methodSignatures.length - 20} more)</li>` : ""}
            </ul>
        </details>`;
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
