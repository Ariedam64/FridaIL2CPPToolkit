import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetField, NetFrame, NetMessageType, NetTypeKey } from "../core/types.js";
import { mountNetworkDetail } from "./network-detail.js";
import { resolveClass, resolveField, onLabelsChange } from "../core/label-resolver.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function flatPreview(f: NetField): string {
    if (f.kind === "nested" || f.kind === "array") return f.preview;
    return f.preview;
}

function lookupField(frame: NetFrame, name: string): NetField | undefined {
    return frame.fields.find((f) => f.name === name);
}

export interface InspectorMountOptions {
    initialKey?: NetTypeKey | null;
    /** Type list provider — used to populate the dropdown. */
    listTypes(): Promise<NetMessageType[]>;
}

export function mountNetworkInspector(host: HTMLElement, opts: InspectorMountOptions): { setType(key: NetTypeKey): void; dispose(): void } {
    let currentKey: NetTypeKey | null = opts.initialKey ?? null;
    let frames: NetFrame[] = [];
    let observedFields: string[] = [];

    host.innerHTML = `
        <div style="padding:10px 14px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border-strong)">
            <label style="color:var(--text-faint);font-size:11px">Type:</label>
            <select id="net-insp-type" style="background:var(--bg-tile);color:var(--text-strong);font-family:var(--font-code);font-size:11px;padding:3px 8px;border:1px solid var(--border-strong);border-radius:4px"></select>
            <button class="pill" id="net-insp-refresh">Refresh</button>
            <span id="net-insp-count" style="margin-left:auto;color:var(--text-faint);font-size:11px"></span>
        </div>
        <div id="net-insp-table" style="flex:1;overflow:auto;padding:8px 14px;font-family:var(--font-code);font-size:11px"></div>
    `;

    const sel = host.querySelector<HTMLSelectElement>("#net-insp-type")!;
    const tbl = host.querySelector<HTMLElement>("#net-insp-table")!;
    const countEl = host.querySelector<HTMLElement>("#net-insp-count")!;

    async function refreshTypeList(): Promise<void> {
        const types = await opts.listTypes();
        sel.innerHTML = types.map((t) => {
            const display = resolveClass(t.key.className);
            const ns = t.key.ns ?? "";
            const value = `${ns}~${t.key.className}`;
            const isSelected = currentKey && currentKey.className === t.key.className && currentKey.ns === t.key.ns;
            return `<option value="${escape(value)}"${isSelected ? " selected" : ""}>${escape(display)} (${t.count})</option>`;
        }).join("");
        if (!currentKey && types.length > 0) currentKey = types[0].key;
    }

    async function refreshTable(): Promise<void> {
        if (!currentKey) {
            tbl.innerHTML = `<div style="color:var(--text-faint)">No type selected.</div>`;
            countEl.textContent = "";
            return;
        }
        const r = await api.getNetworkInstances(currentKey, 50);
        frames = r.frames;
        observedFields = r.type?.observedFields ?? [];
        countEl.textContent = `${frames.length} instances`;

        if (frames.length === 0) {
            tbl.innerHTML = `<div style="color:var(--text-faint)">No instances captured yet.</div>`;
            return;
        }

        let html = `<table style="border-collapse:collapse;width:100%">`;
        html += `<thead><tr style="color:var(--text-faint);border-bottom:1px solid var(--border-strong)">`;
        html += `<th style="text-align:left;padding:4px 8px">Time</th>`;
        html += `<th style="text-align:left;padding:4px 8px">Dir</th>`;
        const cls = currentKey.className;
        for (const fname of observedFields) {
            html += `<th style="text-align:left;padding:4px 8px;cursor:pointer" data-field="${escape(fname)}" title="${escape(fname)}">${escape(resolveField(cls, fname))}</th>`;
        }
        html += `</tr></thead><tbody>`;

        const lastByDir: Record<"in" | "out", Map<string, string>> = { in: new Map(), out: new Map() };

        for (const f of frames) {
            const last = lastByDir[f.direction];
            html += `<tr class="net-insp-row" data-id="${escape(f.id)}" style="border-bottom:1px solid var(--border-strong)">`;
            html += `<td style="padding:3px 8px;color:var(--text-faint)">${new Date(f.timestamp).toISOString().slice(11, 23)}</td>`;
            html += `<td style="padding:3px 8px;color:${f.direction === "in" ? "var(--success)" : "var(--danger)"}">${f.direction === "in" ? "←" : "→"}</td>`;
            for (const fname of observedFields) {
                const fld = lookupField(f, fname);
                const preview = fld ? flatPreview(fld) : "";
                const changed = fld && last.get(fname) !== undefined && last.get(fname) !== preview;
                html += `<td class="net-insp-cell" data-id="${escape(f.id)}" data-field="${escape(fname)}" style="padding:3px 8px;${changed ? "background:var(--indigo-bg)" : ""};max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer">${escape(preview)}</td>`;
                if (fld) last.set(fname, preview);
            }
            html += `</tr>`;
        }
        html += `</tbody></table>`;
        tbl.innerHTML = html;

        tbl.querySelectorAll<HTMLElement>(".net-insp-cell").forEach((td) => {
            td.addEventListener("click", () => {
                const f = frames.find((x) => x.id === td.dataset.id);
                if (!f) return;
                showCellModal(f);
            });
        });
    }

    function showCellModal(frame: NetFrame): void {
        const overlay = document.createElement("div");
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;display:flex;align-items:center;justify-content:center";
        const modal = document.createElement("div");
        modal.style.cssText = "background:var(--bg-base);border:1px solid var(--border-strong);border-radius:8px;width:600px;max-width:90vw;max-height:80vh;overflow:auto";
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        mountNetworkDetail(modal, frame, { onClose: () => overlay.remove() });
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    }

    sel.addEventListener("change", () => {
        const v = sel.value;
        const idx = v.indexOf("~");
        if (idx < 0) return;
        currentKey = { ns: v.slice(0, idx) || null, className: v.slice(idx + 1) };
        void refreshTable();
    });
    host.querySelector<HTMLButtonElement>("#net-insp-refresh")!.addEventListener("click", () => { void refreshTable(); });

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const offFrame = subscribe("network-frame-added", (msg: { frame: { typeKey: NetTypeKey } }) => {
        // Skip frames not for the currently-viewed type.
        if (!currentKey) return;
        const k = msg.frame?.typeKey;
        if (!k || k.className !== currentKey.className || k.ns !== currentKey.ns) return;
        // Debounce so we don't fetch on every frame at high rates.
        if (refreshTimer) return;
        refreshTimer = setTimeout(() => { refreshTimer = null; void refreshTable(); }, 200);
    });

    void refreshTypeList().then(() => refreshTable());
    const offLabels = onLabelsChange(() => {
        // Refresh both the dropdown AND the table to pick up class + field renames.
        void refreshTypeList().then(() => refreshTable());
    });

    return {
        setType(key: NetTypeKey) {
            currentKey = key;
            void refreshTypeList().then(() => refreshTable());
        },
        dispose() {
            offFrame();
            if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
            offLabels();
        },
    };
}
