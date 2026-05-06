import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetMessageType, NetTypeKey } from "../core/types.js";
import { resolveClass, hasClassLabel, resolveField, onLabelsChange } from "../core/label-resolver.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SummaryMountOptions {
    onPickType(key: NetTypeKey): void;
    sharedFilter?: { get(): string; onChange(cb: (v: string) => void): () => void };
}

export function mountNetworkSummary(host: HTMLElement, opts: SummaryMountOptions): () => void {
    let types: NetMessageType[] = [];
    let sortKey: "count" | "lastSeen" | "name" = "count";
    let filter = opts.sharedFilter?.get() ?? "";

    host.innerHTML = `
        <div style="overflow-y:auto;flex:1">
            <table id="net-summary-tbl" style="width:100%;border-collapse:collapse;font-family:var(--font-code);font-size:11px">
                <thead>
                    <tr style="text-align:left;color:var(--text-faint);border-bottom:1px solid var(--border-strong)">
                        <th data-sort="name" style="padding:6px 10px;cursor:pointer">Type</th>
                        <th data-sort="count" style="padding:6px 10px;cursor:pointer">Count</th>
                        <th style="padding:6px 10px">In</th>
                        <th style="padding:6px 10px">Out</th>
                        <th data-sort="lastSeen" style="padding:6px 10px;cursor:pointer">Last seen</th>
                        <th style="padding:6px 10px">Fields observés</th>
                    </tr>
                </thead>
                <tbody id="net-summary-body"></tbody>
            </table>
        </div>
    `;

    const body = host.querySelector<HTMLElement>("#net-summary-body")!;

    function rerender(): void {
        const needle = filter.toLowerCase();
        const filtered = needle
            ? types.filter((t) => `${t.key.ns ?? ""}.${t.key.className}`.toLowerCase().includes(needle))
            : types.slice();
        filtered.sort((a, b) => {
            if (sortKey === "count") return b.count - a.count;
            if (sortKey === "lastSeen") return b.lastSeenAt - a.lastSeenAt;
            return `${a.key.ns ?? ""}.${a.key.className}`.localeCompare(`${b.key.ns ?? ""}.${b.key.className}`);
        });
        body.innerHTML = filtered.map((t) => `
            <tr class="net-sum-row" data-ns="${escape(t.key.ns ?? "")}" data-cls="${escape(t.key.className)}" style="cursor:pointer;border-bottom:1px solid var(--border-strong)">
                <td style="padding:4px 10px;color:var(--text-strong)">${escape(resolveClass(t.key.className))}${hasClassLabel(t.key.className) ? `<span style="color:var(--text-faint);font-size:9px"> [${escape(t.key.className)}]</span>` : ""}</td>
                <td style="padding:4px 10px">${t.count}</td>
                <td style="padding:4px 10px;color:var(--success)">${t.countByDirection.in}</td>
                <td style="padding:4px 10px;color:var(--danger)">${t.countByDirection.out}</td>
                <td style="padding:4px 10px;color:var(--text-faint)">${new Date(t.lastSeenAt).toISOString().slice(11, 23)}</td>
                <td style="padding:4px 10px;color:var(--text-faint);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(t.observedFields.slice(0, 8).map((fn) => resolveField(t.key.className, fn)).join(", "))}${t.observedFields.length > 8 ? "…" : ""}</td>
            </tr>
        `).join("");
        body.querySelectorAll<HTMLElement>(".net-sum-row").forEach((row) => {
            row.addEventListener("click", () => {
                const ns = row.dataset.ns!;
                const cls = row.dataset.cls!;
                opts.onPickType({ ns: ns === "" ? null : ns, className: cls });
            });
        });
    }

    async function refresh(): Promise<void> {
        const r = await api.getNetworkTypes();
        types = r.types;
        rerender();
    }

    host.querySelectorAll<HTMLElement>("th[data-sort]").forEach((th) => {
        th.addEventListener("click", () => {
            sortKey = th.dataset.sort as "count" | "lastSeen" | "name";
            rerender();
        });
    });

    const offFrame = subscribe("network-frame-added", () => { void refresh(); });
    const offCleared = subscribe("network-frames-cleared", () => { void refresh(); });
    const offShared = opts.sharedFilter?.onChange((v) => { filter = v; rerender(); });
    const offLabels = onLabelsChange(() => rerender());

    void refresh();
    return () => { offFrame(); offCleared(); offShared?.(); offLabels(); };
}
