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

interface StaticCandidate {
    id: string;
    path: string;
    assembly: string;
    typeName: string;
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
            <div style="display:flex; gap:2px; align-items:center">
              <select id="sc-asm" class="input" style="flex:1"><option value="Assembly-CSharp">Assembly-CSharp</option></select>
              <button id="sc-asm-refresh" class="btn" style="padding:1px 6px; font-size:10px" title="Reload assembly list from the agent">↻</button>
            </div>
          </label>
          <button id="sc-scan" class="btn primary" style="align-self:flex-end">SCAN</button>
          <button id="sc-scan-static" class="btn" style="align-self:flex-end" title="Scan static fields of the chosen assembly. Cheap — no GC walk.">SCAN STATICS</button>
          <label style="display:flex; align-items:center; gap:4px; font-size:11px; color:var(--c-label); align-self:flex-end; padding-bottom:4px" title="Follow static references into in-assembly objects and scan their instance scalars. Framework types are skipped to avoid crashes.">
            <input type="checkbox" id="sc-dive"> dive
          </label>
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
    const asmEl    = container.querySelector<HTMLSelectElement>("#sc-asm")!;
    const asmRefreshBtn = container.querySelector<HTMLButtonElement>("#sc-asm-refresh")!;
    const scanBtn  = container.querySelector<HTMLButtonElement>("#sc-scan")!;
    const scanStaticBtn = container.querySelector<HTMLButtonElement>("#sc-scan-static")!;
    const diveEl = container.querySelector<HTMLInputElement>("#sc-dive")!;
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

    function renderStaticCandidates(list: StaticCandidate[]): void {
        resultsEl.innerHTML = "";
        for (const c of list) {
            const row = document.createElement("div");
            row.className = "readout";
            row.style.cssText = "display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; padding:var(--s-2) var(--s-3)";
            const isDirect = !c.path.includes(" → ");
            const pinCell = isDirect
                ? `<button class="btn sc-pin-static" data-path="${escHtml(c.path)}" style="font-size:10px; padding:1px 6px">📌 pin</button>`
                : `<span style="font-size:10px; color:var(--c-label)">via singleton</span>`;
            row.innerHTML = `
              <span class="k" style="flex:1; min-width:160px">${escHtml(c.path)}</span>
              <span class="v" style="min-width:80px">${escHtml(c.currentValue)}</span>
              <span style="font-size:10px; color:var(--c-label); min-width:70px">${escHtml(c.typeName.split(".").pop() ?? "")}</span>
              <span style="font-size:10px; color:var(--c-label)">${escHtml(c.assembly)}</span>
              ${pinCell}
            `;
            resultsEl.appendChild(row);
        }
    }

    async function doStaticScan(): Promise<void> {
        const target = valueEl.value.trim();
        const scanType = typeEl.value;
        const asm = asmEl.value.trim() || "Assembly-CSharp";
        const dive = diveEl.checked;
        if (!target) { setStatus("enter a value to search"); return; }
        setStatus(`scanning statics on ${asm}${dive ? " + dive" : ""}…`);
        scanStaticBtn.disabled = true;
        try {
            const results = await rpcCall<StaticCandidate[]>("scanStaticValue", [target, scanType, dive, asm, 200]);
            setStatus(`${results.length} static hit${results.length !== 1 ? "s" : ""}`);
            renderStaticCandidates(results);
            refineRow.style.display = "none"; // static scan doesn't feed rescanByValue
        } catch (err) {
            setStatus(`static scan failed: ${String(err)}`);
            logRpcLine(`[scanner] scanStaticValue failed: ${String(err)}`);
        } finally {
            scanStaticBtn.disabled = false;
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

    async function refreshAssemblies(): Promise<void> {
        try {
            const names = await rpcCall<string[]>("listAssemblies", []);
            if (!names.length) return;
            const prev = asmEl.value;
            asmEl.innerHTML = "";
            for (const n of names) {
                const opt = document.createElement("option");
                opt.value = n;
                opt.textContent = n;
                asmEl.appendChild(opt);
            }
            // Pick best default: keep previous selection if still present, else prefer Core, then Assembly-CSharp.
            const pick = names.includes(prev) ? prev
                : names.includes("Core") ? "Core"
                : names.includes("Assembly-CSharp") ? "Assembly-CSharp"
                : names[0];
            asmEl.value = pick;
        } catch (err) {
            logRpcLine(`[scanner] listAssemblies failed: ${String(err)}`);
        }
    }

    scanBtn.addEventListener("click", () => { void doScan(); });
    scanStaticBtn.addEventListener("click", () => { void doStaticScan(); });
    asmRefreshBtn.addEventListener("click", () => { void refreshAssemblies(); });
    // Auto-populate on mount (no-op if the agent isn't ready yet — user can click ↻).
    void refreshAssemblies();
    rescanBtn.addEventListener("click", () => { void doRescan(); });
    clearBtn.addEventListener("click", async () => {
        try { await rpcCall("clearScan", []); } catch { /* ignore */ }
        resultsEl.innerHTML = "";
        setStatus("cleared");
        refineRow.style.display = "none";
    });

    async function doPinStatic(path: string, rowEl: HTMLElement): Promise<void> {
        const [cls, fld] = path.split(".");
        if (!cls || !fld) return;
        logRpcLine(`[scanner] pinField("static", "${cls}", "${fld}")`);
        try {
            const result = await rpcCall<{ id: string; label: string }>("pinField", ["static", cls, fld, path]);
            addWatchlistPin(result.id, result.label);
            const pinBtn = rowEl.querySelector<HTMLButtonElement>(".sc-pin-static")!;
            pinBtn.textContent = "pinned";
            pinBtn.disabled = true;
        } catch (err) {
            logRpcLine(`[scanner] pin-static failed: ${String(err)}`);
        }
    }

    // Event delegation for pin/edit buttons
    resultsEl.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        const pinBtn = target.closest<HTMLButtonElement>(".sc-pin");
        const pinStaticBtn = target.closest<HTMLButtonElement>(".sc-pin-static");
        const editBtn = target.closest<HTMLButtonElement>(".sc-edit");
        if (pinBtn) {
            const cls = pinBtn.dataset.class ?? "";
            const fld = pinBtn.dataset.field ?? "";
            const rowEl = pinBtn.closest<HTMLElement>(".readout");
            if (cls && fld && rowEl) void doPin(cls, fld, rowEl);
        } else if (pinStaticBtn) {
            const path = pinStaticBtn.dataset.path ?? "";
            const rowEl = pinStaticBtn.closest<HTMLElement>(".readout");
            if (path && rowEl) void doPinStatic(path, rowEl);
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
