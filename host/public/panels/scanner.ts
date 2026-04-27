// Scanner panel — IL2CPP-aware value scanner with refiner and pin-to-watchlist.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";
import { addWatchlistPin } from "./watchlist.js";

interface Candidate {
    id: string;
    className: string;
    fieldName: string;
    handle: string;
    currentValue: string;
}

export function renderScanner(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3)">

        <div style="display:flex; gap:var(--s-2); flex-wrap:wrap; align-items:flex-end">
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label)">
            type
            <select id="sc-type" class="input" style="min-width:90px">
              <option value="int">int</option>
              <option value="float">float</option>
              <option value="string">string</option>
              <option value="bool">bool</option>
            </select>
          </label>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label); flex:1; min-width:80px">
            value
            <input id="sc-value" class="input" placeholder="e.g. 5000" style="width:100%">
          </label>
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label); flex:2; min-width:120px">
            assembly
            <input id="sc-asm" class="input" placeholder="Assembly-CSharp" value="Assembly-CSharp" style="width:100%">
          </label>
          <button id="sc-scan" class="btn primary" style="align-self:flex-end">SCAN</button>
        </div>

        <div id="sc-refine-row" style="display:none; gap:var(--s-2); flex-wrap:wrap; align-items:flex-end">
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label); flex:1; min-width:80px">
            new value
            <input id="sc-next-value" class="input" placeholder="new value to narrow" style="width:100%">
          </label>
          <button id="sc-rescan" class="btn">NEXT SCAN</button>
          <button id="sc-clear" class="btn">CLEAR</button>
        </div>

        <div id="sc-status" style="font-size:11px; color:var(--c-label); min-height:16px"></div>

        <div id="sc-results" style="display:flex; flex-direction:column; gap:var(--s-1)"></div>
      </div>
    `;

    const typeEl   = container.querySelector<HTMLSelectElement>("#sc-type")!;
    const valueEl  = container.querySelector<HTMLInputElement>("#sc-value")!;
    const asmEl    = container.querySelector<HTMLInputElement>("#sc-asm")!;
    const scanBtn  = container.querySelector<HTMLButtonElement>("#sc-scan")!;
    const refineRow = container.querySelector<HTMLElement>("#sc-refine-row")!;
    const nextValEl = container.querySelector<HTMLInputElement>("#sc-next-value")!;
    const rescanBtn = container.querySelector<HTMLButtonElement>("#sc-rescan")!;
    const clearBtn  = container.querySelector<HTMLButtonElement>("#sc-clear")!;
    const statusEl  = container.querySelector<HTMLElement>("#sc-status")!;
    const resultsEl = container.querySelector<HTMLElement>("#sc-results")!;

    let lastScanType = "int";

    function setStatus(msg: string): void {
        statusEl.textContent = msg;
    }

    function renderCandidates(list: Candidate[]): void {
        resultsEl.innerHTML = "";
        for (const c of list) {
            const row = document.createElement("div");
            row.className = "readout";
            row.dataset.id = c.id;
            row.style.cssText = "display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; padding:var(--s-2) var(--s-3)";
            row.innerHTML = `
              <span class="k" style="flex:1; min-width:120px">${escHtml(c.className)}.${escHtml(c.fieldName)}</span>
              <span class="v sc-val" style="min-width:80px">${escHtml(c.currentValue)}</span>
              <button class="btn sc-pin" data-class="${escHtml(c.className)}" data-field="${escHtml(c.fieldName)}" style="font-size:10px; padding:1px 6px">📌 pin</button>
              <button class="btn sc-edit" data-class="${escHtml(c.className)}" data-field="${escHtml(c.fieldName)}" style="font-size:10px; padding:1px 6px">✎ edit</button>
            `;
            resultsEl.appendChild(row);
        }
    }

    async function doScan(): Promise<void> {
        const target = valueEl.value.trim();
        const scanType = typeEl.value;
        const asm = asmEl.value.trim() || "Assembly-CSharp";
        if (!target) { setStatus("enter a value to search"); return; }
        setStatus("scanning… (this may take 1-3s on first call)");
        scanBtn.disabled = true;
        try {
            const results = await rpcCall<Candidate[]>("scanByValue", [target, scanType, asm, 200]);

            lastScanType = scanType;
            setStatus(`${results.length} candidate${results.length !== 1 ? "s" : ""} found`);
            renderCandidates(results);
            refineRow.style.display = results.length > 0 ? "flex" : "none";
        } catch (err) {
            setStatus(`scan failed: ${String(err)}`);
            logRpcLine(`[scanner] scanByValue failed: ${String(err)}`);
        } finally {
            scanBtn.disabled = false;
        }
    }

    async function doRescan(): Promise<void> {
        const target = nextValEl.value.trim();
        if (!target) { setStatus("enter a new value to narrow"); return; }
        setStatus("rescanning…");
        rescanBtn.disabled = true;
        try {
            const results = await rpcCall<Candidate[]>("rescanByValue", [target, lastScanType]);

            setStatus(`${results.length} remain after rescan`);
            renderCandidates(results);
            nextValEl.value = "";
        } catch (err) {
            setStatus(`rescan failed: ${String(err)}`);
            logRpcLine(`[scanner] rescanByValue failed: ${String(err)}`);
        } finally {
            rescanBtn.disabled = false;
        }
    }

    async function doPin(className: string, fieldName: string, rowEl: HTMLElement): Promise<void> {
        const label = `${className}.${fieldName}`;
        logRpcLine(`[scanner] pinField("instance", "${className}", "${fieldName}")`);
        try {
            const result = await rpcCall<{ id: string; label: string }>("pinField", ["instance", className, fieldName, label]);
            addWatchlistPin(result.id, result.label);
            const pinBtn = rowEl.querySelector<HTMLButtonElement>(".sc-pin")!;
            pinBtn.textContent = "pinned";
            pinBtn.disabled = true;
        } catch (err) {
            logRpcLine(`[scanner] pin failed: ${String(err)}`);
        }
    }

    async function doEdit(className: string, fieldName: string, rowEl: HTMLElement): Promise<void> {
        const newVal = prompt(`New value for ${className}.${fieldName}:`);
        if (newVal === null) return;
        logRpcLine(`[scanner] writeField("${className}", "${fieldName}", "${newVal}")`);
        try {
            await rpcCall("writeField", [className, fieldName, parseScalarValue(newVal)]);
            // Refresh this row's current value
            const current = await rpcCall<string>("readField", [className, fieldName]);
            const valEl = rowEl.querySelector<HTMLElement>(".sc-val");
            if (valEl) valEl.textContent = String(current);
        } catch (err) {
            logRpcLine(`[scanner] writeField failed: ${String(err)}`);
        }
    }

    scanBtn.addEventListener("click", () => { void doScan(); });
    rescanBtn.addEventListener("click", () => { void doRescan(); });
    clearBtn.addEventListener("click", async () => {
        try { await rpcCall("clearScan", []); } catch { /* ignore */ }
        resultsEl.innerHTML = "";
        setStatus("cleared");
        refineRow.style.display = "none";
    });

    // Event delegation for pin/edit buttons
    resultsEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const pinBtn = target.closest<HTMLButtonElement>(".sc-pin");
        const editBtn = target.closest<HTMLButtonElement>(".sc-edit");
        if (pinBtn) {
            const cls = pinBtn.dataset.class ?? "";
            const fld = pinBtn.dataset.field ?? "";
            const rowEl = pinBtn.closest<HTMLElement>(".readout");
            if (cls && fld && rowEl) void doPin(cls, fld, rowEl);
        } else if (editBtn) {
            const cls = editBtn.dataset.class ?? "";
            const fld = editBtn.dataset.field ?? "";
            const rowEl = editBtn.closest<HTMLElement>(".readout");
            if (cls && fld && rowEl) void doEdit(cls, fld, rowEl);
        }
    });
}

function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseScalarValue(v: string): unknown {
    if (v === "true")  return true;
    if (v === "false") return false;
    if (v === "null")  return null;
    if (/^-?\d+$/.test(v))      return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
}
