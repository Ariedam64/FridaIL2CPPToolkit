// Pretty-print indented detail view (validated variant A).
// Used in two places:
//  - side-panel slide-in from Stream click
//  - modal from Inspector cell click

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

function renderField(f: NetField, expanded: Set<string>, path: string): string {
    const childPath = `${path}.${f.name}`;
    const hasChildren = !!f.children?.length;
    const open = hasChildren && expanded.has(childPath);
    const caret = hasChildren ? `<span class="net-caret" data-path="${childPath}">${open ? "▼" : "▶"}</span>` : `<span class="net-caret-spacer"></span>`;
    const html = `
        <div class="net-field-line">
            ${caret}
            <span class="net-field-name">${escape(f.name)}</span>
            <span class="net-field-kind">${escape(f.kind)}</span>
            <span class="net-field-value" style="color:${KIND_COLORS[f.kind]}">${escape(f.preview)}</span>
        </div>
    `;
    if (open && hasChildren) {
        const inner = (f.children ?? []).map((c) => renderField(c, expanded, childPath)).join("");
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
    // Auto-expand top-level nested/array nodes for at-a-glance readability.
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
                    <div class="net-obf">${escape(frame.typeKey.ns ?? "")} @ ${new Date(frame.timestamp).toISOString().slice(11, 23)}</div>
                </div>
                ${opts.onClose ? `<button class="icon-btn-mini" id="net-detail-close">✕</button>` : ""}
            </div>
            <div class="net-detail">
                ${frame.fields.map((f) => renderField(f, expanded, "")).join("")}
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

    rerender();
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
