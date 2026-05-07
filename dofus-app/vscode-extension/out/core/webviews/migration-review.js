"use strict";
// Webview to review a single migration candidate. Shows old fingerprint
// vs. candidate fingerprint side by side with Accept / Reject buttons.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.openMigrationReview = openMigrationReview;
const vscode = __importStar(require("vscode"));
async function openMigrationReview(input, onAccept, onReject) {
    const panel = vscode.window.createWebviewPanel("fridaMigrationReview", `Migration: ${input.label}`, vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: false });
    panel.webview.html = render(input);
    panel.webview.onDidReceiveMessage(async (msg) => {
        try {
            if (msg.type === "accept" && msg.newObf) {
                await onAccept(msg.newObf);
                panel.dispose();
            }
            else if (msg.type === "reject") {
                await onReject();
                panel.dispose();
            }
        }
        catch (err) {
            const m = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Migration action failed: ${m}`);
        }
    });
}
function render(input) {
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
function renderFingerprint(fp) {
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
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
//# sourceMappingURL=migration-review.js.map