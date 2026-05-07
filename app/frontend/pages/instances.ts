// app/frontend/pages/instances.ts — v1.4 Instances plugin page
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";
import { renderFieldRow } from "../components/instance-field-row.js";
import { openCaptureWizard } from "../components/instance-capture-wizard-modal.js";
import { openRecipesModal } from "../components/instance-recipes-modal.js";
import type { CapturedInstanceLite, FieldReadLite, InstanceHistoryEntry } from "../core/types.js";
import { prettyClassName } from "../core/il2cpp-pretty.js";

let _hostEl: HTMLElement | null = null;
let _instances: CapturedInstanceLite[] = [];
let _activeKey: string | null = null;
let _activeFields: FieldReadLite[] = [];
let _activeAlive = true;
let _activeError: string | null = null;
let _readOnly = true;
let _history: InstanceHistoryEntry[] = [];
let _listenersAttached = false;

export function mountInstancesPage(host: HTMLElement): void {
    _hostEl = host;
    host.style.flex = "1";
    host.style.display = "flex";
    host.style.flexDirection = "column";
    void loadAll();

    if (!_listenersAttached) {
        _listenersAttached = true;
        subscribe("instance-registry-changed", () => { void loadInstances(); });
        subscribe("instance-history-changed", () => { void loadHistory(); });
        subscribe("read-only-changed", () => { void loadReadOnly(); });
        window.addEventListener("instances:open-wizard", ((ev: CustomEvent) => {
            openCaptureWizard({
                prefillClassName: ev.detail?.className,
                instances: _instances,
                onSubmitted: () => { void loadInstances(); },
            });
        }) as EventListener);
        window.addEventListener("instances:open-recipes", () => { void openRecipesModal(); });
    }

    setTimeout(() => {
        const hash = window.location.hash;
        const pickedMatch = hash.match(/[?&]picked=([^&]+)/);
        if (pickedMatch) {
            // Already captured via picker — just activate it.
            const key = decodeURIComponent(pickedMatch[1]);
            void loadInstances().then(() => {
                _activeKey = key;
                void loadActiveFields().then(render);
            });
            return;
        }
        const m = hash.match(/[?&]class=([^&]+)/);
        if (!m) return;
        const className = decodeURIComponent(m[1]);
        const isAuto = /[?&]auto=1/.test(hash);
        if (isAuto) {
            // Auto-capture via GC at index 0. Use className as asKey by default.
            const asKey = className.split(".").pop()?.toLowerCase() || className.toLowerCase();
            api.captureInstance({ op: "captureViaGC", className, index: 0, asKey })
                .then(() => { void loadInstances(); })
                .catch((err) => alert(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`));
        } else {
            window.dispatchEvent(new CustomEvent("instances:open-wizard", { detail: { className } }));
        }
    }, 0);
}

async function loadAll(): Promise<void> {
    await Promise.all([loadInstances(), loadHistory(), loadReadOnly()]);
    render();
}

async function loadInstances(): Promise<void> {
    try {
        const r = await api.listInstances();
        _instances = r.instances;
        if (_activeKey && !_instances.find((i) => i.key === _activeKey)) _activeKey = null;
        if (!_activeKey && _instances.length > 0) _activeKey = _instances[0].key;
        if (_activeKey) await loadActiveFields();
        render();
    } catch (e) { renderError(e); }
}

async function loadActiveFields(): Promise<void> {
    if (!_activeKey) { _activeFields = []; _activeError = null; return; }
    try {
        const r = await api.readInstanceFields(_activeKey);
        _activeAlive = r.alive;
        _activeFields = r.fields;
        _activeError = r.error ?? null;
    } catch (e) {
        _activeFields = [];
        _activeAlive = false;
        _activeError = e instanceof Error ? e.message : String(e);
    }
}

async function loadHistory(): Promise<void> {
    try {
        const r = await api.getInstanceHistory();
        _history = r.entries;
        renderHistory();
    } catch { _history = []; }
}

async function loadReadOnly(): Promise<void> {
    try {
        const r = await api.getInstancesReadOnly();
        _readOnly = r.enabled;
        render();
    } catch { /* keep current value */ }
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderError(e: unknown): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `<div style="padding:14px;color:var(--danger)">${escape(String(e))}</div>`;
}

function render(): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `
        <style>
            .ip-toolbar { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--border-strong); background:var(--bg-elevated); }
            .ip-pill { padding:3px 8px; border-radius:3px; font-size:11px; cursor:pointer; border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-strong); display:inline-flex; align-items:center; gap:4px; }
            .ip-pill:hover { background:var(--bg-hover); }
            .ip-pill.active { background:var(--accent); color:var(--bg); }
            .ip-pill.danger { color:var(--danger); }
            .ip-body { flex:1; display:flex; overflow:hidden; }
            .ip-sidebar { width:300px; border-right:1px solid var(--border-strong); overflow-y:auto; background:var(--bg-elevated); }
            .ip-viewer { flex:1; overflow-y:auto; padding:12px; }
            .ip-history { width:320px; border-left:1px solid var(--border-strong); overflow-y:auto; background:var(--bg-elevated); }
            .ip-section-title { font-size:10px; color:var(--text-faint); padding:8px 12px; text-transform:uppercase; letter-spacing:0.05em; }
            .ip-instance { padding:6px 12px; cursor:pointer; border-bottom:1px solid var(--border-strong); }
            .ip-instance:hover { background:var(--bg-hover); }
            .ip-instance.active { background:rgba(99,102,241,0.12); border-left:2px solid var(--accent); padding-left:10px; }
            .ip-instance .key { font-weight:600; font-family:var(--font-code); font-size:12px; }
            .ip-instance .meta { font-size:10px; color:var(--text-faint); margin-top:2px; }
            .ip-instance.dead { opacity:0.5; }
            .ip-field-row { display:flex; align-items:baseline; gap:8px; padding:3px 0; font-family:var(--font-code); font-size:12px; }
            .ip-field-name { min-width:140px; color:var(--text-strong); }
            .ip-field-type { min-width:60px; color:var(--syntax-type); font-size:10px; }
            .ip-field-value { flex:1; color:var(--syntax-name); }
            .ip-input { background:var(--bg); border:1px solid var(--border-strong); color:var(--text-strong); font-family:var(--font-code); font-size:11px; padding:1px 4px; }
            .ip-history-row { padding:6px 12px; border-bottom:1px solid var(--border-strong); font-family:var(--font-code); font-size:11px; }
            .ip-history-tag { display:inline-block; padding:1px 5px; border-radius:3px; font-size:9px; font-weight:600; margin-right:6px; }
            .ip-history-tag.write { background:rgba(99,102,241,0.15); color:var(--accent); }
            .ip-history-tag.call { background:rgba(245,158,11,0.15); color:var(--warning); }
            .ip-instance-del:hover { background:var(--bg-hover); color:var(--danger); }
        </style>
        <div class="ip-toolbar">
            <button class="ip-pill" id="ip-new-capture">${icons.crosshair(12)} New capture</button>
            <button class="ip-pill" id="ip-recipes">${icons.folder(12)} Recipes</button>
            <button class="ip-pill ${_readOnly ? "active" : ""}" id="ip-toggle-ro">${_readOnly ? "🔒" : "🔓"} Read-Only</button>
            <button class="ip-pill" id="ip-refresh">${icons.refresh(12)} Refresh</button>
            <span style="flex:1"></span>
            <span style="color:var(--text-faint);font-size:11px">${_instances.length} captured · ${_history.length} history</span>
        </div>
        <div class="ip-body">
            <div class="ip-sidebar" id="ip-sidebar"></div>
            <div class="ip-viewer" id="ip-viewer"></div>
            <div class="ip-history" id="ip-history"></div>
        </div>
    `;
    renderSidebar();
    renderViewer();
    renderHistory();
    bindToolbar();
}

function renderSidebar(): void {
    if (!_hostEl) return;
    const sb = _hostEl.querySelector<HTMLElement>("#ip-sidebar");
    if (!sb) return;
    sb.innerHTML = `<div class="ip-section-title">Captured Instances (${_instances.length})</div>`;
    for (const inst of _instances) {
        const isActive = inst.key === _activeKey;
        const div = document.createElement("div");
        div.className = `ip-instance ${isActive ? "active" : ""} ${inst.isAlive ? "" : "dead"}`;
        div.style.position = "relative";
        div.innerHTML = `
            <div class="key">${escape(inst.key)}</div>
            <div class="meta">${escape(prettyClassName(inst.className))}@${escape(inst.handle)} ${inst.isAlive ? "" : "(dead)"}</div>
            <button class="ip-instance-del" data-del title="Remove this capture" style="position:absolute;top:6px;right:6px;background:transparent;border:none;color:var(--text-faint);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:3px;display:none">×</button>
        `;
        div.addEventListener("mouseenter", () => {
            const btn = div.querySelector<HTMLButtonElement>("[data-del]");
            if (btn) btn.style.display = "inline-block";
        });
        div.addEventListener("mouseleave", () => {
            const btn = div.querySelector<HTMLButtonElement>("[data-del]");
            if (btn) btn.style.display = "none";
        });
        div.querySelector<HTMLButtonElement>("[data-del]")?.addEventListener("click", async (ev) => {
            ev.stopPropagation();
            if (!confirm(`Remove capture "${inst.key}"?`)) return;
            try {
                await api.deleteInstance(inst.key);
                // The WS event "instance-registry-changed" will refresh the sidebar.
            } catch (err) {
                alert(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        div.addEventListener("click", () => {
            _activeKey = inst.key;
            void loadActiveFields().then(render);
        });
        sb.appendChild(div);
    }
    if (_instances.length === 0) {
        sb.innerHTML += `<div style="padding:14px;color:var(--text-faint);font-size:11px;text-align:center">No captures yet.<br>Click "New capture" to start.</div>`;
    }
}

function renderViewer(): void {
    if (!_hostEl) return;
    const v = _hostEl.querySelector<HTMLElement>("#ip-viewer");
    if (!v) return;
    if (!_activeKey) {
        v.innerHTML = `<div style="color:var(--text-faint);padding:14px">Select a capture from the sidebar.</div>`;
        return;
    }
    const inst = _instances.find((i) => i.key === _activeKey);
    if (!inst) { v.innerHTML = ""; return; }
    v.innerHTML = `
        <h3 style="margin-top:0;font-family:var(--font-code);font-size:14px">${escape(inst.key)} → ${escape(prettyClassName(inst.className))}@${escape(inst.handle)}</h3>
        ${!_activeAlive ? `<div style="color:var(--danger);font-size:11px;margin-bottom:8px">⚠ instance appears dead${_activeError ? `: <code>${escape(_activeError)}</code>` : " — re-capture to refresh"}</div>` : ""}
        <div class="ip-section-title">Fields (${_activeFields.length})</div>
        <div id="ip-fields"></div>
        <div class="ip-section-title" style="margin-top:18px">Methods (call)</div>
        <div id="ip-methods"></div>
    `;
    const activeKey = _activeKey;
    const fc = v.querySelector<HTMLElement>("#ip-fields");
    if (fc) {
        for (const f of _activeFields) {
            fc.appendChild(renderFieldRow({
                instanceKey: activeKey,
                field: f,
                readOnly: _readOnly,
                onDrillDown: (field) => {
                    const asKey = `${activeKey}.${field.name}`;
                    if (field.kind === "nested") {
                        void api.captureInstance({ op: "captureFieldValue", ownerKey: activeKey, fieldName: field.name, asKey });
                    } else if (field.kind === "array") {
                        const idx = window.prompt(`Array element index (0-${(field.arrayLength ?? 1) - 1}):`, "0");
                        if (idx === null) return;
                        void api.captureInstance({ op: "captureListElement", ownerKey: activeKey, listFieldName: field.name, index: parseInt(idx, 10), asKey: `${asKey}[${idx}]` });
                    }
                },
                onWriteSucceeded: () => { void loadActiveFields().then(render); },
            }));
        }
    }
    const mc = v.querySelector<HTMLElement>("#ip-methods");
    if (mc) {
        // listClassMembers returns { methods: string[], fields: string[] } — names only
        void api.rpc<{ methods: string[]; fields: string[] }>(
            "listClassMembers", [inst.className],
        ).then((r) => {
            const methodNames = r.result.methods;
            if (methodNames.length === 0) {
                mc.innerHTML = `<div style="color:var(--text-faint);font-size:11px;padding:4px 0">No methods found.</div>`;
                return;
            }
            for (const name of methodNames) {
                const row = document.createElement("div");
                row.className = "ip-field-row";
                row.innerHTML = `
                    <span class="ip-field-name">${escape(name)}</span>
                    <span class="ip-field-type" style="min-width:0"></span>
                    <button class="ip-pill" data-call="${escape(name)}" ${_readOnly ? "disabled" : ""}>Call</button>
                `;
                row.querySelector<HTMLButtonElement>(`[data-call]`)?.addEventListener("click", () => {
                    import("../components/instance-call-modal.js").then(({ openCallModal }) => {
                        openCallModal({
                            instanceKey: activeKey,
                            methodName: name,
                            parameters: [],
                            onResult: (result) => { console.log("call result:", result); },
                        });
                    });
                });
                mc.appendChild(row);
            }
        }).catch(() => { mc.innerHTML = `<div style="color:var(--text-faint);font-size:11px">unable to list methods</div>`; });
    }
}

function renderHistory(): void {
    if (!_hostEl) return;
    const h = _hostEl.querySelector<HTMLElement>("#ip-history");
    if (!h) return;
    h.innerHTML = `<div class="ip-section-title">History (${_history.length})${_history.length > 0 ? ` <button class="ip-pill" id="ip-clear-history" style="margin-left:8px">Clear</button>` : ""}</div>`;
    for (const e of _history) {
        const time = new Date(e.timestamp).toISOString().slice(11, 19);
        const div = document.createElement("div");
        div.className = "ip-history-row";
        const tag = `<span class="ip-history-tag ${e.action}">${e.action.toUpperCase()}</span>`;
        const body = e.action === "write"
            ? `${tag}${escape(e.target.instanceKey)}.${escape(e.target.member)}<br><span style="color:var(--text-faint)">${escape(e.before ?? "")} → ${escape(e.after ?? "")}</span>`
            : `${tag}${escape(e.target.instanceKey)}.${escape(e.target.member)}()<br><span style="color:var(--text-faint)">→ ${escape(e.callResult ?? "")}</span>`;
        div.innerHTML = `<div style="color:var(--text-faint);font-size:9px">${time}</div>${body}`;
        h.appendChild(div);
    }
    h.querySelector<HTMLButtonElement>("#ip-clear-history")?.addEventListener("click", async () => {
        await api.clearInstanceHistory();
    });
}

function bindToolbar(): void {
    if (!_hostEl) return;
    _hostEl.querySelector<HTMLButtonElement>("#ip-toggle-ro")?.addEventListener("click", async () => {
        await api.setInstancesReadOnly(!_readOnly);
    });
    _hostEl.querySelector<HTMLButtonElement>("#ip-refresh")?.addEventListener("click", () => { void loadAll(); });
    _hostEl.querySelector<HTMLButtonElement>("#ip-new-capture")?.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("instances:open-wizard"));
    });
    _hostEl.querySelector<HTMLButtonElement>("#ip-recipes")?.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("instances:open-recipes"));
    });
}
