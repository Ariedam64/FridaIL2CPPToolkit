import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { ScanMatchLite } from "../core/types.js";
import { prettyClassName, prettyFieldName } from "../core/il2cpp-pretty.js";

const ALL_NUMERIC_TYPES = [
    "System.Int16", "System.Int32", "System.Int64",
    "System.UInt16", "System.UInt32", "System.UInt64",
    "System.Byte", "System.SByte",
    "System.Single", "System.Double",
];
const ALL_OTHER_TYPES = ["System.Boolean", "System.String"];

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function coerceValue(raw: string): string | number | boolean {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
    if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
    return raw;
}

function defaultTypesForValue(raw: string): Set<string> {
    if (raw === "true" || raw === "false") return new Set(["System.Boolean"]);
    if (/^-?\d+$/.test(raw)) return new Set(["System.Int32", "System.Int64", "System.UInt32", "System.UInt64"]);
    if (/^-?\d+\.\d+$/.test(raw)) return new Set(["System.Single", "System.Double"]);
    return new Set(["System.String"]);
}

export function openScanModal(): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;padding:20px;width:840px;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.5)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
                <h3 style="margin:0">Find by value</h3>
                <span style="font-size:11px;color:var(--text-faint)">Cheat Engine-style scan over the IL2CPP heap snapshot</span>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px">
                    <span style="color:var(--text-faint)">Value</span>
                    <input class="ip-input" id="scan-value" placeholder="e.g. 23541, true, hello" style="width:100%">
                </label>
                <label style="display:flex;flex-direction:column;gap:3px;font-size:11px">
                    <span style="color:var(--text-faint)">Class filter (regex, optional)</span>
                    <input class="ip-input" id="scan-classfilter" placeholder="e.g. Inventory|Player|^dofus\\." style="width:100%">
                </label>
            </div>

            <div style="margin-bottom:12px">
                <div style="font-size:11px;color:var(--text-faint);margin-bottom:4px">Field types to scan (default: auto-narrowed by value type)</div>
                <div id="scan-types" style="display:flex;flex-wrap:wrap;gap:6px"></div>
            </div>

            <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
                <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="scan-skipfw" checked> Skip framework classes</label>
                <span style="flex:1"></span>
                <button class="ip-pill" id="scan-first" style="background:var(--accent);color:var(--bg)">&#9654; First Scan</button>
                <button class="ip-pill" id="scan-next" disabled>&#8658; Next Scan</button>
                <button class="ip-pill danger" id="scan-reset" disabled>&#10226; Reset</button>
            </div>

            <div id="scan-status" style="font-size:11px;color:var(--text-faint);margin-bottom:6px">Idle. Enter a value and click First Scan.</div>
            <div id="scan-progress" style="height:6px;background:var(--bg-elevated);border-radius:3px;margin-bottom:8px;overflow:hidden;display:none">
                <div id="scan-progress-bar" style="height:100%;background:var(--accent);width:0;transition:width 100ms linear"></div>
            </div>

            <div id="scan-results" style="flex:1;overflow-y:auto;border:1px solid var(--border-strong);border-radius:4px;background:var(--bg-elevated);padding:6px;min-height:240px"></div>

            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-close>Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const valueInput = overlay.querySelector<HTMLInputElement>("#scan-value")!;
    const classFilterInput = overlay.querySelector<HTMLInputElement>("#scan-classfilter")!;
    const skipFwInput = overlay.querySelector<HTMLInputElement>("#scan-skipfw")!;
    const typesContainer = overlay.querySelector<HTMLElement>("#scan-types")!;
    const firstBtn = overlay.querySelector<HTMLButtonElement>("#scan-first")!;
    const nextBtn = overlay.querySelector<HTMLButtonElement>("#scan-next")!;
    const resetBtn = overlay.querySelector<HTMLButtonElement>("#scan-reset")!;
    const statusEl = overlay.querySelector<HTMLElement>("#scan-status")!;
    const progressBox = overlay.querySelector<HTMLElement>("#scan-progress")!;
    const progressBar = overlay.querySelector<HTMLElement>("#scan-progress-bar")!;
    const resultsEl = overlay.querySelector<HTMLElement>("#scan-results")!;

    let scanInProgress = false;
    let userPickedTypes = false;  // Whether the user has manually toggled type checkboxes.

    function renderTypeChips(selected: Set<string>): void {
        const chip = (t: string): string => {
            const short = t.replace(/^System\./, "");
            const checked = selected.has(t) ? "checked" : "";
            return `<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;padding:3px 8px;background:var(--bg-elevated);border:1px solid var(--border-strong);border-radius:12px;cursor:pointer">
                <input type="checkbox" data-type="${escape(t)}" ${checked}> ${escape(short)}
            </label>`;
        };
        typesContainer.innerHTML = [
            ...ALL_NUMERIC_TYPES.map(chip),
            ...ALL_OTHER_TYPES.map(chip),
            `<button class="ip-pill" id="types-all" style="font-size:10px">all</button>`,
            `<button class="ip-pill" id="types-none" style="font-size:10px">none</button>`,
        ].join("");
        typesContainer.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => {
            cb.addEventListener("change", () => { userPickedTypes = true; });
        });
        typesContainer.querySelector<HTMLButtonElement>("#types-all")?.addEventListener("click", () => {
            typesContainer.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => { cb.checked = true; });
            userPickedTypes = true;
        });
        typesContainer.querySelector<HTMLButtonElement>("#types-none")?.addEventListener("click", () => {
            typesContainer.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((cb) => { cb.checked = false; });
            userPickedTypes = true;
        });
    }
    renderTypeChips(defaultTypesForValue(""));

    // Auto-update type defaults when value changes (unless user has manually picked).
    valueInput.addEventListener("input", () => {
        if (!userPickedTypes) renderTypeChips(defaultTypesForValue(valueInput.value.trim()));
    });

    function selectedTypes(): string[] {
        return Array.from(typesContainer.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")).map((cb) => cb.dataset.type!);
    }

    // Subscribe to scan-progress events from the agent.
    const offProgress = subscribe("scan-progress", (msg: { scanned: number; total: number; found: number; phase?: string; done?: boolean }) => {
        if (!scanInProgress) return;
        const pct = msg.total > 0 ? (msg.scanned / msg.total) * 100 : 0;
        progressBar.style.width = pct.toFixed(1) + "%";
        const phaseLabel = msg.phase === "snapshot" ? "Capturing heap snapshot..."
            : msg.phase === "done" ? "Done"
            : `Scanning ${msg.scanned}/${msg.total} objects`;
        statusEl.innerHTML = `<span>${phaseLabel} — ${msg.found} match${msg.found === 1 ? "" : "es"}</span>`;
    });

    function close(): void { offProgress(); overlay.remove(); }

    function renderResults(matches: ScanMatchLite[]): void {
        if (matches.length === 0) {
            resultsEl.innerHTML = `<div style="color:var(--text-faint);padding:16px;text-align:center">No matches.</div>`;
            return;
        }
        resultsEl.innerHTML = matches.map((m, i) => `
            <div style="display:flex;align-items:baseline;gap:8px;padding:5px 8px;border-bottom:1px solid var(--border-strong);font-family:var(--font-code);font-size:11px">
                <span style="color:var(--text-faint);min-width:40px">[${i}]</span>
                <span style="color:var(--text-strong);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(prettyClassName(m.className))}</span>
                <span style="color:var(--text-faint)">${escape(m.handle)}</span>
                <span style="color:var(--syntax-name)">${escape(prettyFieldName(m.fieldName))}=${escape(m.fieldValue)}</span>
                <button class="ip-pill" data-capture="${i}">Capture</button>
            </div>
        `).join("");
        resultsEl.querySelectorAll<HTMLButtonElement>("[data-capture]").forEach((b) => {
            b.addEventListener("click", async () => {
                const idx = parseInt(b.dataset.capture!, 10);
                const match = matches[idx];
                const baseKey = match.className.split(".").pop()?.toLowerCase() ?? "match";
                const asKey = `${baseKey}_scan${idx}`;
                try {
                    await api.captureFromScan(idx, asKey);
                    close();
                    location.hash = `#/instances?picked=${encodeURIComponent(asKey)}`;
                } catch (err) {
                    alert(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            });
        });
    }

    async function runFirst(): Promise<void> {
        const raw = valueInput.value.trim();
        if (!raw) { statusEl.textContent = "Enter a value first."; return; }
        const value = coerceValue(raw);
        const classFilter = classFilterInput.value.trim() || undefined;
        const skipFramework = skipFwInput.checked;
        const typeFilter = selectedTypes();
        progressBox.style.display = "block";
        progressBar.style.width = "0";
        scanInProgress = true;
        firstBtn.disabled = true;
        statusEl.innerHTML = `<span style="color:var(--warning)">Starting scan...</span>`;
        try {
            const t0 = Date.now();
            const { matches } = await api.scanStart(value, { classFilter, skipFramework, typeFilter });
            const ms = Date.now() - t0;
            statusEl.innerHTML = `<span style="color:var(--success)">Found ${matches.length} match${matches.length === 1 ? "" : "es"} in ${ms}ms.</span>`;
            renderResults(matches);
            nextBtn.disabled = matches.length === 0;
            resetBtn.disabled = false;
        } catch (err) {
            statusEl.innerHTML = `<span style="color:var(--danger)">Scan failed: ${escape(String(err))}</span>`;
        } finally {
            firstBtn.disabled = false;
            scanInProgress = false;
            setTimeout(() => { progressBox.style.display = "none"; }, 1500);
        }
    }

    async function runNext(): Promise<void> {
        const raw = valueInput.value.trim();
        if (!raw) { statusEl.textContent = "Enter a new value first."; return; }
        const value = coerceValue(raw);
        statusEl.innerHTML = `<span style="color:var(--warning)">Refining...</span>`;
        nextBtn.disabled = true;
        try {
            const t0 = Date.now();
            const { matches } = await api.scanRefine(value);
            const ms = Date.now() - t0;
            statusEl.innerHTML = `<span style="color:var(--success)">${matches.length} match${matches.length === 1 ? "" : "es"} after refine (${ms}ms).</span>`;
            renderResults(matches);
            nextBtn.disabled = matches.length === 0;
        } catch (err) {
            statusEl.innerHTML = `<span style="color:var(--danger)">Refine failed: ${escape(String(err))}</span>`;
        } finally {
            if (overlay.parentNode) nextBtn.disabled = false;
        }
    }

    async function runReset(): Promise<void> {
        await api.scanReset();
        renderResults([]);
        statusEl.textContent = "Reset.";
        nextBtn.disabled = true;
        resetBtn.disabled = true;
    }

    firstBtn.addEventListener("click", () => { void runFirst(); });
    nextBtn.addEventListener("click", () => { void runNext(); });
    resetBtn.addEventListener("click", () => { void runReset(); });
    overlay.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", close);

    // Restore prior scan state (if any)
    void api.getScan().then(({ matches }) => {
        if (matches.length > 0) {
            renderResults(matches);
            statusEl.textContent = `Restored prior scan: ${matches.length} match${matches.length === 1 ? "" : "es"}.`;
            nextBtn.disabled = false;
            resetBtn.disabled = false;
        }
    }).catch(() => {});
}
