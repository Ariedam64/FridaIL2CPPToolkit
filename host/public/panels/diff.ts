// Diff panel — T0/T1 snapshot and changed-fields highlight.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";
import { copyMarkdown } from "../lib/clipboard.js";

interface SnapshotResult {
    className: string;
    fields: Record<string, string>;
}

interface DiffRow {
    field: string;
    t0: string;
    t1: string;
    delta: string;
    changed: boolean;
}

export function renderDiff(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); height:100%; box-sizing:border-box">

        <div style="display:flex; gap:var(--s-2); align-items:flex-end; flex-wrap:wrap">
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label); flex:1; min-width:120px">
            captured key
            <input id="diff-key" class="input" placeholder="e.g. Player" style="width:100%">
          </label>
          <button id="diff-t0" class="btn primary">TAKE T0</button>
          <button id="diff-t1" class="btn" disabled>TAKE T1</button>
          <button id="diff-clear" class="btn">CLEAR</button>
          <button id="diff-copy" class="btn" title="Copy changed rows as markdown">📋 Copy diff for Claude</button>
        </div>

        <div style="display:flex; gap:var(--s-3); font-size:11px">
          <div>
            <span style="color:var(--c-label)">T0: </span>
            <span id="diff-t0-label" style="color:var(--c-label); font-style:italic">not taken</span>
          </div>
          <div>
            <span style="color:var(--c-label)">T1: </span>
            <span id="diff-t1-label" style="color:var(--c-label); font-style:italic">not taken</span>
          </div>
        </div>

        <div style="display:flex; gap:var(--s-3); align-items:center">
          <label style="font-size:11px; display:flex; align-items:center; gap:var(--s-1)">
            <input type="checkbox" id="diff-changed-first" checked>
            <span>changed first</span>
          </label>
          <span id="diff-status" style="font-size:11px; color:var(--c-label)"></span>
        </div>

        <div id="diff-table-wrap" style="flex:1; overflow:auto">
          <table id="diff-table" style="width:100%; border-collapse:collapse; font-family:var(--font-mono); font-size:12px; display:none">
            <thead>
              <tr style="border-bottom:1px solid var(--c-border)">
                <th style="text-align:left; padding:4px 8px; color:var(--c-label); font-weight:500">field</th>
                <th style="text-align:left; padding:4px 8px; color:var(--c-label); font-weight:500">T0</th>
                <th style="text-align:left; padding:4px 8px; color:var(--c-label); font-weight:500">T1</th>
                <th style="text-align:left; padding:4px 8px; color:var(--c-label); font-weight:500">Δ</th>
              </tr>
            </thead>
            <tbody id="diff-tbody"></tbody>
          </table>
        </div>
      </div>
    `;

    const keyEl          = container.querySelector<HTMLInputElement>("#diff-key")!;
    const t0Btn          = container.querySelector<HTMLButtonElement>("#diff-t0")!;
    const t1Btn          = container.querySelector<HTMLButtonElement>("#diff-t1")!;
    const clearBtn       = container.querySelector<HTMLButtonElement>("#diff-clear")!;
    const copyBtn        = container.querySelector<HTMLButtonElement>("#diff-copy")!;
    const t0Label        = container.querySelector<HTMLElement>("#diff-t0-label")!;
    const t1Label        = container.querySelector<HTMLElement>("#diff-t1-label")!;
    const changedFirst   = container.querySelector<HTMLInputElement>("#diff-changed-first")!;
    const statusEl       = container.querySelector<HTMLElement>("#diff-status")!;
    const tableEl        = container.querySelector<HTMLTableElement>("#diff-table")!;
    const tbodyEl        = container.querySelector<HTMLElement>("#diff-tbody")!;

    let snapshotT0: SnapshotResult | null = null;
    let snapshotT1: SnapshotResult | null = null;
    let lastDiff: DiffRow[] = [];

    // Try to populate key from listCaptured
    void (async () => {
        try {
            const captured = await rpcCall<string[]>("listCaptured", []);
            if (captured && captured.length > 0) {
                // format: "name → Class@handle" — extract just the key name
                const last = captured[captured.length - 1];
                const key = last.split(" → ")[0]?.trim() ?? last;
                keyEl.placeholder = key;
            }
        } catch { /* ignore */ }
    })();

    function getKey(): string {
        return keyEl.value.trim() || keyEl.placeholder;
    }

    function setStatus(msg: string): void {
        statusEl.textContent = msg;
    }

    async function takeSnapshot(slot: "t0" | "t1"): Promise<void> {
        const key = getKey();
        if (!key || key === "e.g. Player") { setStatus("enter a captured key first"); return; }
        const btn = slot === "t0" ? t0Btn : t1Btn;
        btn.disabled = true;
        try {
            const result = await rpcCall<SnapshotResult | null>("snapshotInstance", [key]);
            if (!result) {
                setStatus(`no captured instance for "${key}"`);
                return;
            }
            const ts = new Date().toLocaleTimeString();
            if (slot === "t0") {
                snapshotT0 = result;
                t0Label.textContent = `${result.className} @ ${ts}`;
                t0Label.style.color = "var(--c-accent)";
                t0Label.style.fontStyle = "normal";
                t1Btn.disabled = false;
                setStatus("T0 snapshot taken");
                // Clear T1 on new T0
                snapshotT1 = null;
                t1Label.textContent = "not taken";
                t1Label.style.color = "var(--c-label)";
                t1Label.style.fontStyle = "italic";
                tableEl.style.display = "none";
            } else {
                snapshotT1 = result;
                t1Label.textContent = `${result.className} @ ${ts}`;
                t1Label.style.color = "var(--c-accent)";
                t1Label.style.fontStyle = "normal";
                computeAndRenderDiff();
            }
        } catch (err) {
            setStatus(`snapshot failed: ${String(err)}`);
            logRpcLine(`[diff] snapshotInstance failed: ${String(err)}`);
        } finally {
            btn.disabled = false;
        }
    }

    function computeAndRenderDiff(): void {
        if (!snapshotT0 || !snapshotT1) return;

        const allFields = new Set([...Object.keys(snapshotT0.fields), ...Object.keys(snapshotT1.fields)]);
        const rows: DiffRow[] = [];
        let changedCount = 0;
        for (const field of allFields) {
            const t0Val = snapshotT0.fields[field] ?? "(missing)";
            const t1Val = snapshotT1.fields[field] ?? "(missing)";
            const changed = t0Val !== t1Val;
            if (changed) changedCount++;
            const delta = computeDelta(t0Val, t1Val);
            rows.push({ field, t0: t0Val, t1: t1Val, delta, changed });
        }
        lastDiff = rows;
        setStatus(`${changedCount} changed out of ${rows.length} fields`);
        renderTable(rows);
    }

    function computeDelta(t0: string, t1: string): string {
        if (t0 === t1) return "—";
        // Numeric delta
        const n0 = parseFloat(t0);
        const n1 = parseFloat(t1);
        if (!isNaN(n0) && !isNaN(n1) && String(n0) === t0 && String(n1) === t1) {
            const d = n1 - n0;
            return d > 0 ? `+${d}` : String(d);
        }
        if (!isNaN(n0) && !isNaN(n1) && /^-?\d+(\.\d+)?$/.test(t0) && /^-?\d+(\.\d+)?$/.test(t1)) {
            const d = n1 - n0;
            return d > 0 ? `+${d}` : String(d);
        }
        // String change
        if (t0.length < 40 && t1.length < 40) return `${t0} → ${t1}`;
        return "changed";
    }

    function renderTable(rows: DiffRow[]): void {
        const sorted = [...rows];
        if (changedFirst.checked) {
            sorted.sort((a, b) => {
                if (a.changed && !b.changed) return -1;
                if (!a.changed && b.changed) return 1;
                return a.field.localeCompare(b.field);
            });
        } else {
            sorted.sort((a, b) => a.field.localeCompare(b.field));
        }
        tbodyEl.innerHTML = "";
        for (const row of sorted) {
            const tr = document.createElement("tr");
            if (row.changed) {
                tr.style.background = "rgba(204, 160, 29, 0.12)";
            }
            const tdStyle = "padding:3px 8px; border-bottom:1px solid var(--c-border)";
            tr.innerHTML = `
              <td style="${tdStyle}; color:var(--c-label)">${escHtml(row.field)}</td>
              <td style="${tdStyle}">${escHtml(row.t0)}</td>
              <td style="${tdStyle}">${escHtml(row.t1)}</td>
              <td style="${tdStyle}; ${row.changed ? "color:var(--c-accent); font-weight:600" : "color:var(--c-label)"}">${escHtml(row.delta)}</td>
            `;
            tbodyEl.appendChild(tr);
        }
        tableEl.style.display = "";
    }

    function buildDiffMarkdown(): string {
        if (!snapshotT0 || !lastDiff.length) return "(no diff computed)";
        const className = snapshotT0.className;
        const changed = lastDiff.filter(r => r.changed);
        if (changed.length === 0) return `## ${className} diff\n\n(no changes detected)`;
        const lines = [`## ${className} diff — ${changed.length} changed field(s)`, ""];
        lines.push("| field | T0 | T1 | Δ |");
        lines.push("|---|---|---|---|");
        for (const r of changed) {
            lines.push(`| ${r.field} | ${r.t0} | ${r.t1} | ${r.delta} |`);
        }
        return lines.join("\n");
    }

    t0Btn.addEventListener("click", () => { void takeSnapshot("t0"); });
    t1Btn.addEventListener("click", () => { void takeSnapshot("t1"); });
    clearBtn.addEventListener("click", () => {
        snapshotT0 = null;
        snapshotT1 = null;
        lastDiff = [];
        t0Label.textContent = "not taken";
        t0Label.style.color = "var(--c-label)";
        t0Label.style.fontStyle = "italic";
        t1Label.textContent = "not taken";
        t1Label.style.color = "var(--c-label)";
        t1Label.style.fontStyle = "italic";
        t1Btn.disabled = true;
        tableEl.style.display = "none";
        setStatus("cleared");
    });
    copyBtn.addEventListener("click", () => {
        void copyMarkdown(buildDiffMarkdown());
    });
    changedFirst.addEventListener("change", () => {
        if (lastDiff.length > 0) renderTable(lastDiff);
    });
}

function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
