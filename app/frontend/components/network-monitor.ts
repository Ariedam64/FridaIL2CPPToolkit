import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";
import type { NetMessageType, NetTypeKey } from "../core/types.js";
import { mountNetworkStream } from "./network-stream.js";
import { mountNetworkSummary } from "./network-summary.js";
import { mountNetworkInspector } from "./network-inspector.js";
import { showNetworkConfig } from "./network-config.js";
import { resolveClass, hasClassLabel, onLabelsChange } from "../core/label-resolver.js";
import { muteStore } from "./network-mute-store.js";

const SIDEBAR_WIDTH_KEY = "frida.network.sidebar.width";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function makeSharedFilter() {
    let v = "";
    const listeners: Array<(v: string) => void> = [];
    return {
        get: () => v,
        set: (next: string) => { v = next; for (const l of listeners) try { l(next); } catch {} },
        onChange: (cb: (v: string) => void) => {
            listeners.push(cb);
            return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
        },
    };
}

export function mountNetworkMonitor(host: HTMLElement): () => void {
    let sidebarWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? "240", 10);
    sidebarWidth = Math.max(180, Math.min(600, sidebarWidth));
    const sharedFilter = makeSharedFilter();
    let inspectorPreselect: NetTypeKey | null = null;

    host.style.flex = "1";
    host.style.display = "flex";
    host.style.minHeight = "0";
    host.style.position = "relative";
    host.innerHTML = `
        <div id="net-sidebar" style="width:${sidebarWidth}px;flex-shrink:0;background:var(--bg-elevated);border-right:1px solid var(--border-strong);display:flex;flex-direction:column;overflow:hidden">
            <div style="padding:8px 10px;border-bottom:1px solid var(--border-strong)">
                <input id="net-sidebar-filter" placeholder="filter…" style="width:100%;font-family:var(--font-code);font-size:11px;padding:4px 8px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
            </div>
            <div id="net-sidebar-tree" style="flex:1;overflow-y:auto;padding:6px 4px;font-family:var(--font-code);font-size:11px"></div>
            <div style="padding:8px 10px;border-top:1px solid var(--border-strong);display:flex;gap:6px;align-items:center">
                <span id="net-status" style="font-size:10px;color:var(--text-faint);flex:1">${icons.circle()} Disarmed</span>
                <button class="pill" id="net-cfg-btn" title="Configure">${icons.settings()}</button>
                <button class="pill" id="net-startstop-btn">${icons.play()} Start</button>
            </div>
        </div>
        <div id="net-resizer" style="width:4px;cursor:col-resize;background:var(--border-strong)"></div>
        <div id="net-main" style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg-base)">
            <div style="display:flex;border-bottom:1px solid var(--border-strong);padding:0 12px;gap:2px">
                <button class="net-tab" data-tab="stream" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Stream</button>
                <button class="net-tab" data-tab="summary" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Summary</button>
                <button class="net-tab" data-tab="inspector" style="padding:8px 12px;background:transparent;color:var(--text-faint);border:none;border-bottom:2px solid transparent;cursor:pointer">Inspector</button>
            </div>
            <div id="net-tabhost" style="flex:1;display:flex;flex-direction:column;min-height:0;position:relative"></div>
        </div>
    `;

    const sidebar = host.querySelector<HTMLElement>("#net-sidebar")!;
    const resizer = host.querySelector<HTMLElement>("#net-resizer")!;
    let dragging = false;
    resizer.addEventListener("pointerdown", (e) => {
        dragging = true;
        resizer.setPointerCapture(e.pointerId);
    });
    resizer.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = host.getBoundingClientRect();
        const w = Math.max(180, Math.min(600, e.clientX - rect.left));
        sidebar.style.width = w + "px";
        sidebarWidth = w;
    });
    resizer.addEventListener("pointerup", (e) => {
        dragging = false;
        resizer.releasePointerCapture(e.pointerId);
        localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    });

    const filterInput = host.querySelector<HTMLInputElement>("#net-sidebar-filter")!;
    filterInput.addEventListener("input", () => sharedFilter.set(filterInput.value));

    const tabHost = host.querySelector<HTMLElement>("#net-tabhost")!;
    let disposeTab: (() => void) | null = null;
    let inspectorHandle: { setType(k: NetTypeKey): void; dispose(): void } | null = null;

    function mountTab(t: "stream" | "summary" | "inspector"): void {
        host.querySelectorAll<HTMLElement>(".net-tab").forEach((b) => {
            const active = b.dataset.tab === t;
            b.style.color = active ? "var(--indigo)" : "var(--text-faint)";
            b.style.borderColor = active ? "var(--indigo)" : "transparent";
        });
        if (disposeTab) { disposeTab(); disposeTab = null; }
        if (inspectorHandle) { inspectorHandle.dispose(); inspectorHandle = null; }
        tabHost.innerHTML = "";
        const inner = document.createElement("div");
        inner.style.cssText = "flex:1;display:flex;flex-direction:column;min-height:0";
        tabHost.appendChild(inner);

        if (t === "stream") {
            disposeTab = mountNetworkStream(inner, { sharedFilter, onRename: handleRename });
        } else if (t === "summary") {
            disposeTab = mountNetworkSummary(inner, {
                sharedFilter,
                onPickType: (k) => { inspectorPreselect = k; mountTab("inspector"); },
            });
        } else {
            inspectorHandle = mountNetworkInspector(inner, {
                initialKey: inspectorPreselect,
                listTypes: async () => (await api.getNetworkTypes()).types,
            });
            inspectorPreselect = null;
        }
    }

    host.querySelectorAll<HTMLElement>(".net-tab").forEach((b) => {
        b.addEventListener("click", () => mountTab(b.dataset.tab as "stream" | "summary" | "inspector"));
    });

    async function handleRename(typeKey: NetTypeKey): Promise<void> {
        const current = typeKey.className;
        const next = window.prompt(`Rename class ${current} →`, current);
        if (!next || next === current) return;
        try {
            await api.setLabel("class", { kind: "class", className: typeKey.className }, next);
            void refreshTree();
        } catch (err) {
            alert(`Rename failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    const tree = host.querySelector<HTMLElement>("#net-sidebar-tree")!;
    async function refreshTree(): Promise<void> {
        const r = await api.getNetworkTypes();
        const inTypes = r.types.filter((t) => t.countByDirection.in > 0).sort((a, b) => b.count - a.count);
        const outTypes = r.types.filter((t) => t.countByDirection.out > 0 && t.countByDirection.in === 0).sort((a, b) => b.count - a.count);
        const needle = sharedFilter.get().toLowerCase();
        const renderType = (t: NetMessageType): string => {
            const labelOrObf = resolveClass(t.key.className);
            const obfSuffix = hasClassLabel(t.key.className)
                ? ` <span style="color:var(--text-faint);font-size:9px">[${escape(t.key.className)}]</span>`
                : "";
            const display = `${t.key.ns ? escape(t.key.ns) + "." : ""}<strong>${escape(labelOrObf)}</strong>${obfSuffix}`;
            const matches = !needle || `${t.key.ns ?? ""}.${t.key.className}`.toLowerCase().includes(needle);
            if (!matches) return "";
            const dot = t.countByDirection.in > 0 ? "var(--success)" : "var(--danger)";
            const muted = muteStore.has(t.key.className);
            const muteIcon = muted ? "🔕" : "🔔";
            const rowOpacity = muted ? "opacity:0.45;text-decoration:line-through" : "";
            return `<div class="net-tree-row" data-ns="${escape(t.key.ns ?? "")}" data-cls="${escape(t.key.className)}" style="padding:3px 8px;cursor:pointer;display:flex;gap:6px;align-items:baseline;${rowOpacity}">
                <span style="color:${dot};font-size:7px">●</span>
                <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${display}</span>
                <span style="color:var(--text-faint);font-size:10px">×${t.count}</span>
                <button class="net-tree-mute" data-cls="${escape(t.key.className)}" title="${muted ? "Unmute" : "Mute"} this class" style="background:transparent;border:0;color:var(--text-faint);cursor:pointer;font-size:11px;padding:0 2px">${muteIcon}</button>
            </div>`;
        };
        tree.innerHTML = `
            <div style="padding:4px 8px;color:var(--success);font-weight:600">▼ S2C (Receive) — ${inTypes.length}</div>
            ${inTypes.map(renderType).join("")}
            <div style="padding:8px 8px 4px;color:var(--danger);font-weight:600">▼ C2S (Send) — ${outTypes.length}</div>
            ${outTypes.map(renderType).join("")}
        `;
        tree.querySelectorAll<HTMLElement>(".net-tree-row").forEach((row) => {
            row.addEventListener("click", (e) => {
                if ((e.target as HTMLElement).classList.contains("net-tree-mute")) return;
                const ns = row.dataset.ns!;
                const cls = row.dataset.cls!;
                const key = { ns: ns === "" ? null : ns, className: cls };
                inspectorPreselect = key;
                mountTab("inspector");
            });
        });
        tree.querySelectorAll<HTMLButtonElement>(".net-tree-mute").forEach((btn) => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation();
                muteStore.toggle(btn.dataset.cls!);
            });
        });
    }

    let armed = false;
    const statusEl = host.querySelector<HTMLElement>("#net-status")!;
    const startBtn = host.querySelector<HTMLButtonElement>("#net-startstop-btn")!;
    function setArmed(a: boolean, n?: number): void {
        armed = a;
        statusEl.innerHTML = a
            ? `<span style="color:var(--success)">${icons.circleFill()}</span> Armed${n !== undefined ? ` (${n} hooks)` : ""}`
            : `${icons.circle()} Disarmed`;
        startBtn.innerHTML = a ? `${icons.pause()} Stop` : `${icons.play()} Start`;
    }
    startBtn.addEventListener("click", async () => {
        try {
            if (armed) {
                const r = await api.stopNetworkCapture();
                setArmed(false);
                if (r.reverted > 0) console.log(`[network] disarmed ${r.reverted} hooks`);
            } else {
                const r = await api.startNetworkCapture();
                setArmed(true, r.installed);
                if (r.failed && r.failed.length > 0) {
                    alert(`${r.failed.length} entries failed to install. Check Configure for stale entries.`);
                }
            }
        } catch (err) {
            alert(`${err instanceof Error ? err.message : String(err)}`);
        }
    });
    host.querySelector<HTMLButtonElement>("#net-cfg-btn")!.addEventListener("click", () => {
        showNetworkConfig({ onSaved: () => { /* WS broadcasts serializer-config-change */ } });
    });

    const offTreeRefresh1 = subscribe("network-frame-added", () => { void refreshTree(); });
    const offTreeRefresh2 = subscribe("network-frames-cleared", () => { void refreshTree(); });
    const offCfgChange = subscribe("serializer-config-change", () => { /* nothing visible to do here */ });
    const offLabels = onLabelsChange(() => { void refreshTree(); });
    const offMute = muteStore.onChange(() => { void refreshTree(); });

    void refreshTree();
    mountTab("stream");

    return () => {
        offTreeRefresh1();
        offTreeRefresh2();
        offCfgChange();
        offLabels();
        offMute();
        if (disposeTab) disposeTab();
        if (inspectorHandle) inspectorHandle.dispose();
    };
}
