// app/frontend/pages/migrations.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";
import type { LabelKeyLite } from "../core/types.js";

interface MigrationCandidate { newObf: string; score: number; reason: string; }

interface ReviewRecord {
    key: LabelKeyLite;
    oldObf: string;
    candidates: MigrationCandidate[];
    label: string;
    parentClassMigration?: string;
}

interface AutoRecord {
    key: LabelKeyLite;
    oldObf: string;
    newObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

interface LostRecord {
    key: LabelKeyLite;
    oldObf: string;
    label: string;
    reason: string;
    parentClassMigration?: string;
}

interface MigrationResult {
    auto: AutoRecord[];
    review: ReviewRecord[];
    lost: LostRecord[];
}

let _state: MigrationResult = { auto: [], review: [], lost: [] };
let _expandedClasses = new Set<string>();   // newObf of class with breakdown shown
let _lostExpanded = false;
let _showOnlyReviews = false;
let _hostEl: HTMLElement | null = null;

export function mountMigrationsPage(host: HTMLElement): void {
    _hostEl = host;
    host.style.flex = "1";
    void load();
    subscribe("migration-updated", () => { void load(); });
}

async function load(): Promise<void> {
    try {
        const body = await api.getMigrations();
        _state = body.result ?? { auto: [], review: [], lost: [] };
        render();
    } catch (e) {
        if (_hostEl) _hostEl.innerHTML = `<div style="color:var(--danger);padding:14px">${escape(String(e))}</div>`;
    }
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function kindIcon(k: LabelKeyLite["kind"]): string {
    if (k === "class")  return icons.layers(12);
    if (k === "method") return icons.hook(12);
    return icons.note(12);
}

function render(): void {
    if (!_hostEl) return;
    _hostEl.innerHTML = `
        <style>
            .mig-toolbar { display:flex; gap:8px; align-items:center; padding:8px 14px; border-bottom:1px solid var(--border-strong); background:var(--bg-elevated); }
            .mig-zone-title { font-size:11px; color:var(--text-faint); padding:8px 14px; text-transform:uppercase; letter-spacing:0.05em; }
            .mig-row { padding:8px 14px; border-bottom:1px solid var(--border-strong); font-family:var(--font-code); font-size:12px; }
            .mig-row.review { background:rgba(245,158,11,0.04); }
            .mig-row.auto { background:transparent; }
            .mig-row.lost { background:rgba(239,68,68,0.04); }
            .mig-cands { margin-left:24px; margin-top:4px; }
            .mig-cand { padding:2px 0; display:flex; gap:8px; align-items:center; }
            .mig-cand-actions { display:flex; gap:4px; }
            .mig-pill { padding:2px 6px; border-radius:3px; font-size:10px; cursor:pointer; border:1px solid var(--border-strong); background:var(--bg-elevated); color:var(--text-strong); }
            .mig-pill:hover { background:var(--bg-hover); }
            .mig-pill.danger { color:var(--danger); }
            .mig-breakdown { margin-left:24px; padding:6px 0; color:var(--text-faint); }
            .mig-breakdown-row { padding:1px 0; }
            .mig-old { color:var(--text-faint); }
            .mig-arrow { color:var(--text-faint); }
            .mig-label { color:var(--syntax-name); font-weight:600; }
        </style>
        <div class="mig-toolbar">
            <button class="mig-pill" id="mig-accept-all">${icons.check(12)} Accept top candidate for all REVIEWs (${_state.review.length})</button>
            <button class="mig-pill" id="mig-toggle-only-reviews">${_showOnlyReviews ? "Show all" : "Show only REVIEWs"}</button>
            <button class="mig-pill" id="mig-export">${icons.clipboard(12)} Export NDJSON</button>
            <span style="flex:1"></span>
            <span style="color:var(--text-faint);font-size:11px">${_state.auto.length} auto · ${_state.review.length} review · ${_state.lost.length} lost</span>
        </div>
        <div id="mig-body" style="overflow-y:auto"></div>
    `;
    const body = _hostEl.querySelector<HTMLElement>("#mig-body")!;
    body.appendChild(renderReviewZone());
    if (!_showOnlyReviews) {
        body.appendChild(renderAutoZone());
        body.appendChild(renderLostZone());
    }
    bindToolbar();
}

function renderReviewZone(): HTMLElement {
    const wrap = document.createElement("div");
    if (_state.review.length === 0) {
        wrap.innerHTML = `<div class="mig-zone-title">No REVIEWs pending</div>`;
        return wrap;
    }
    wrap.innerHTML = `<div class="mig-zone-title">REVIEWs (${_state.review.length}) — pick a candidate</div>`;
    for (const r of _state.review) {
        const div = document.createElement("div");
        div.className = "mig-row review";
        div.innerHTML = `
            <div>${kindIcon(r.key.kind)} <strong class="mig-label">${escape(r.label)}</strong>
                <span class="mig-old">${escape(r.oldObf)}</span> <span class="mig-arrow">→ ?</span>
                ${r.parentClassMigration ? `<span style="color:var(--text-faint);font-size:10px"> [under class ${escape(r.parentClassMigration)}]</span>` : ""}
            </div>
            <div class="mig-cands"></div>
        `;
        const cands = div.querySelector<HTMLElement>(".mig-cands")!;
        for (const c of r.candidates) {
            const cand = document.createElement("div");
            cand.className = "mig-cand";
            cand.innerHTML = `
                <span style="flex:1"><span class="mig-old">${escape(c.newObf)}</span> <span style="color:var(--text-faint);font-size:10px">(score ${c.score.toFixed(2)} · ${escape(c.reason)})</span></span>
                <div class="mig-cand-actions">
                    <button class="mig-pill" data-action="accept">Accept</button>
                </div>
            `;
            cand.querySelector<HTMLButtonElement>('[data-action="accept"]')!.addEventListener("click", () => {
                void doAccept(r, c);
            });
            cands.appendChild(cand);
        }
        const reject = document.createElement("button");
        reject.className = "mig-pill danger";
        reject.textContent = "Reject all";
        reject.style.marginLeft = "24px";
        reject.style.marginTop = "4px";
        reject.addEventListener("click", () => { void doReject(r); });
        div.appendChild(reject);
        wrap.appendChild(div);
    }
    return wrap;
}

function renderAutoZone(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="mig-zone-title">AUTOs (${_state.auto.length}) — applied automatically</div>`;
    return wrap; // populated by Task 18
}

function renderLostZone(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.innerHTML = `<div class="mig-zone-title">LOST (${_state.lost.length})</div>`;
    return wrap; // populated by Task 19
}

function bindToolbar(): void {
    if (!_hostEl) return;
    _hostEl.querySelector<HTMLButtonElement>("#mig-accept-all")?.addEventListener("click", () => { void doAcceptAll(); });
    _hostEl.querySelector<HTMLButtonElement>("#mig-toggle-only-reviews")?.addEventListener("click", () => {
        _showOnlyReviews = !_showOnlyReviews;
        render();
    });
    _hostEl.querySelector<HTMLButtonElement>("#mig-export")?.addEventListener("click", () => { void exportNdjson(); });
}

async function doAccept(r: ReviewRecord, c: MigrationCandidate): Promise<void> {
    let key: LabelKeyLite;
    if (r.key.kind === "class") {
        key = { kind: "class", className: c.newObf };
    } else if (r.key.kind === "method") {
        const dot = c.newObf.lastIndexOf(".");
        key = { kind: "method", className: c.newObf.slice(0, dot), methodName: c.newObf.slice(dot + 1) };
    } else {
        const dot = c.newObf.lastIndexOf(".");
        key = { kind: "field", className: c.newObf.slice(0, dot), fieldName: c.newObf.slice(dot + 1) };
    }
    await api.acceptMigration({ key, oldObf: r.oldObf });
}

async function doReject(r: ReviewRecord): Promise<void> {
    await api.rejectMigration({ key: r.key, oldObf: r.oldObf });
}

async function doAcceptAll(): Promise<void> {
    if (_state.review.length === 0) return;
    const ok = window.confirm(`This will accept the top candidate for all ${_state.review.length} pending REVIEWs. Continue?`);
    if (!ok) return;
    await api.acceptTopForAllReviews();
}

function exportNdjson(): void {
    const lines = [
        ..._state.auto.map((r) => JSON.stringify({ status: "auto", ...r })),
        ..._state.review.map((r) => JSON.stringify({ status: "review", ...r })),
        ..._state.lost.map((r) => JSON.stringify({ status: "lost", ...r })),
    ];
    const blob = new Blob([lines.join("\n")], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `migration-report-${Date.now()}.ndjson`;
    a.click();
    URL.revokeObjectURL(url);
}
