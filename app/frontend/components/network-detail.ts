// Pretty-print indented detail view (validated variant A).
// Used in two places:
//  - side-panel slide-in from Stream click
//  - modal from Inspector cell click

import { api } from "../core/api.js";
import { resolveField, hasFieldLabel, onLabelsChange } from "../core/label-resolver.js";
import type { NetField, NetFrame } from "../core/types.js";

const KIND_COLORS: Record<NetField["kind"], string> = {
    int: "var(--syntax-type)",
    long: "var(--syntax-type)",
    float: "var(--syntax-type)",
    bool: "var(--warning)",
    enum: "var(--warning)",
    string: "var(--syntax-return)",
    bytes: "var(--text-faint)",
    nested: "var(--method)",
    array: "var(--method)",
    null: "var(--text-faint)",
    unknown: "var(--text-faint)",
};

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderField(
    f: NetField,
    expanded: Set<string>,
    path: string,
    className: string,
    isTopLevel: boolean,
): string {
    const childPath = `${path}.${f.name}`;
    const hasChildren = !!f.children?.length;
    const open = hasChildren && expanded.has(childPath);
    const caret = hasChildren ? `<span class="net-caret" data-path="${childPath}">${open ? "▼" : "▶"}</span>` : `<span class="net-caret-spacer"></span>`;
    const renamed = isTopLevel && hasFieldLabel(className, f.name);
    const nameDisplay = renamed
        ? `<strong style="color:var(--syntax-name)">${escape(resolveField(className, f.name))}</strong> <span style="color:var(--text-faint);font-size:10px">[${escape(f.name)}]</span>`
        : `${escape(f.name)}`;
    const renamableAttr = isTopLevel ? `data-rename-field="${escape(f.name)}"` : "";
    const html = `
        <div class="net-field-line" ${renamableAttr} ${isTopLevel ? 'title="Right-click to rename"' : ""}>
            ${caret}
            <span class="net-field-name">${nameDisplay}</span>
            <span class="net-field-kind">${escape(f.kind)}</span>
            <span class="net-field-value" style="color:${KIND_COLORS[f.kind]}">${escape(f.preview)}</span>
        </div>
    `;
    if (open && hasChildren) {
        const inner = (f.children ?? []).map((c) => renderField(c, expanded, childPath, className, false)).join("");
        return html + `<div class="net-nested">${inner}</div>`;
    }
    return html;
}

export interface DetailMountOptions {
    onRename?(typeKey: { ns: string | null; className: string }): void;
    onClose?(): void;
}

export function mountNetworkDetail(host: HTMLElement, frame: NetFrame, opts: DetailMountOptions = {}): void {
    const expanded = new Set<string>();
    for (const f of frame.fields) {
        if (f.children?.length) expanded.add(`.${f.name}`);
    }

    function rerender(): void {
        host.innerHTML = `
            <style>
                .net-detail { padding: 14px; font-family: var(--font-code); font-size: 12px; line-height: 1.7; color: var(--text-strong); }
                .net-detail-header { padding: 10px 14px; background: var(--bg-elevated); border-bottom: 1px solid var(--border-strong); display: flex; justify-content: space-between; align-items: center; gap: 12px; }
                .net-detail-title { font-weight: 600; font-size: 13px; }
                .net-direction-pill { padding: 1px 8px; border-radius: 10px; font-size: 10px; font-weight: 600; }
                .net-direction-pill.in { background: rgba(34,197,94,0.15); color: var(--success); }
                .net-direction-pill.out { background: rgba(239,68,68,0.15); color: var(--danger); }
                .net-obf { color: var(--text-faint); font-size: 10px; }
                .net-field-line { display: flex; align-items: baseline; gap: 8px; }
                .net-field-line[data-rename-field] { cursor: context-menu; }
                .net-field-line[data-rename-field]:hover { background: rgba(99,102,241,0.07); }
                .net-field-name { color: var(--text-strong); min-width: 140px; }
                .net-field-kind { color: var(--syntax-type); font-size: 10px; min-width: 50px; }
                .net-field-value { flex: 1; word-break: break-word; }
                .net-nested { margin-left: 24px; border-left: 1px solid var(--border-strong); padding-left: 12px; }
                .net-caret, .net-caret-spacer { width: 14px; color: var(--text-faint); cursor: pointer; user-select: none; }
                .net-detail-toolbar { background: var(--bg-elevated); border-top: 1px solid var(--border-strong); padding: 8px 14px; display: flex; gap: 8px; }
                .net-detail-toolbar .pill { font-size: 10px; }
            </style>
            <div class="net-detail-header">
                <div>
                    <div class="net-detail-title">${escape(frame.typeKey.className)}<span class="net-direction-pill ${frame.direction}" style="margin-left:8px">${frame.direction === "in" ? "← S2C" : "→ C2S"}</span></div>
                    <div class="net-obf">${escape(frame.typeKey.ns ?? "")} @ ${new Date(frame.timestamp).toISOString().slice(11, 23)} <span style="color:var(--text-faint)">· right-click a field to rename</span></div>
                </div>
                ${opts.onClose ? `<button class="icon-btn-mini" id="net-detail-close">✕</button>` : ""}
            </div>
            <div class="net-detail">
                ${frame.fields.map((f) => renderField(f, expanded, "", frame.typeKey.className, true)).join("")}
                ${frame.truncated ? `<div style="color:var(--warning);margin-top:8px">… truncated (frame too large)</div>` : ""}
            </div>
            <div class="net-detail-toolbar">
                <button class="pill" id="net-detail-rename">Rename type</button>
                <button class="pill" id="net-detail-copy">Copy JSON</button>
                <button class="pill" id="net-detail-expand">Expand all</button>
                <button class="pill" id="net-detail-collapse">Collapse all</button>
            </div>
        `;

        host.querySelectorAll<HTMLElement>(".net-caret").forEach((el) => {
            el.addEventListener("click", () => {
                const p = el.dataset.path!;
                if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
                rerender();
            });
        });
        // Right-click on a top-level field → rename via labels.ts
        host.querySelectorAll<HTMLElement>(".net-field-line[data-rename-field]").forEach((row) => {
            row.addEventListener("contextmenu", async (ev) => {
                ev.preventDefault();
                const fieldName = row.dataset.renameField!;
                const className = frame.typeKey.className;
                const current = hasFieldLabel(className, fieldName) ? resolveField(className, fieldName) : "";
                const next = window.prompt(`Rename field ${className}.${fieldName} →\n(empty to remove the rename)`, current);
                if (next === null) return;
                try {
                    if (next === "") {
                        await api.removeLabel("field", { kind: "field", className, fieldName });
                    } else {
                        await api.setLabel("field", { kind: "field", className, fieldName }, next);
                    }
                    // No need to refetch; the WS label-change subscriber updates state and rerenders.
                } catch (err) {
                    alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
        });
        host.querySelector<HTMLButtonElement>("#net-detail-close")?.addEventListener("click", () => opts.onClose?.());
        host.querySelector<HTMLButtonElement>("#net-detail-rename")?.addEventListener("click", () => opts.onRename?.(frame.typeKey));
        host.querySelector<HTMLButtonElement>("#net-detail-copy")?.addEventListener("click", () => {
            void navigator.clipboard.writeText(JSON.stringify(frame, null, 2));
        });
        host.querySelector<HTMLButtonElement>("#net-detail-expand")?.addEventListener("click", () => {
            collectAllPaths(frame.fields, "", expanded);
            rerender();
        });
        host.querySelector<HTMLButtonElement>("#net-detail-collapse")?.addEventListener("click", () => {
            expanded.clear();
            rerender();
        });
    }

    // First synchronous render — resolver already has labels from its eager init.
    rerender();

    const offLabels = onLabelsChange(() => rerender());

    // Cleanup on host removal: detach resolver subscription. Best-effort —
    // MutationObserver could be more rigorous, but the parent currently
    // sets innerHTML="" which removes the listener anchor.
    const origCleanup = (host as { __netDetailCleanup?: () => void }).__netDetailCleanup;
    (host as { __netDetailCleanup?: () => void }).__netDetailCleanup = () => {
        offLabels();
        if (origCleanup) origCleanup();
    };
}

function collectAllPaths(fields: NetField[], prefix: string, into: Set<string>): void {
    for (const f of fields) {
        const p = `${prefix}.${f.name}`;
        if (f.children?.length) {
            into.add(p);
            collectAllPaths(f.children, p, into);
        }
    }
}
