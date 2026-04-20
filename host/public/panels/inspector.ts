// Inspector panel — navigate a captured instance's fields as an interactive tree.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine } from "./logs.js";
import { addWatchlistPin } from "./watchlist.js";
import { copyMarkdown } from "../lib/clipboard.js";

interface FieldNode {
    name: string;
    typeName: string;
    kind: "primitive" | "reference" | "list" | "null" | "error";
    value?: string;
    listCount?: number;
    listElemType?: string;
}

interface InspectResult {
    className: string;
    handle: string;
    fields: FieldNode[];
}

interface ListItem {
    index: number;
    summary: string;
    isReference: boolean;
}

export function renderInspector(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); height:100%; box-sizing:border-box">

        <div style="display:flex; gap:var(--s-2); align-items:flex-end; flex-wrap:wrap">
          <label style="display:flex; flex-direction:column; gap:2px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--c-label); flex:1; min-width:120px">
            captured key
            <input id="insp-key" class="input" placeholder="e.g. Player" style="width:100%">
          </label>
          <button id="insp-load" class="btn primary">INSPECT</button>
          <button id="insp-copy" class="btn" title="Copy visible tree as markdown">📋 Copy tree</button>
        </div>

        <div style="font-size:10px; color:var(--c-label); line-height:1.4">
          Note: List item drill-down (▸ inspect on list elements) is not supported in M4. Use the Instance panel → capture list element manually.
        </div>

        <div id="insp-status" style="font-size:11px; color:var(--c-label); min-height:16px"></div>

        <div id="insp-tree" style="flex:1; overflow:auto; display:flex; flex-direction:column; gap:2px; font-family:var(--font-mono); font-size:12px"></div>
      </div>
    `;

    const keyEl    = container.querySelector<HTMLInputElement>("#insp-key")!;
    const loadBtn  = container.querySelector<HTMLButtonElement>("#insp-load")!;
    const copyBtn  = container.querySelector<HTMLButtonElement>("#insp-copy")!;
    const statusEl = container.querySelector<HTMLElement>("#insp-status")!;
    const treeEl   = container.querySelector<HTMLElement>("#insp-tree")!;

    // Tree state for copy-for-claude
    let currentResult: InspectResult | null = null;
    // Expanded subtrees: key → fields result
    const expandedRefs = new Map<string, InspectResult>();
    const expandedLists = new Map<string, ListItem[]>();

    function setStatus(msg: string): void {
        statusEl.textContent = msg;
    }

    // Try to populate the key input from listCaptured on mount
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

    async function doInspect(key: string): Promise<void> {
        if (!key) { setStatus("enter a captured key"); return; }
        setStatus("loading…");
        loadBtn.disabled = true;
        expandedRefs.clear();
        expandedLists.clear();
        try {
            const result = await rpcCall<InspectResult | null>("inspectInstance", [key]);
            if (!result) {
                setStatus(`no captured instance for key "${key}"`);
                treeEl.innerHTML = "";
                currentResult = null;
                return;
            }
            currentResult = result;
            setStatus(`${result.className}@${result.handle} — ${result.fields.length} field(s)`);
            renderTree(treeEl, result, key, 0);
        } catch (err) {
            setStatus(`inspect failed: ${String(err)}`);
            logRpcLine(`[inspector] inspectInstance failed: ${String(err)}`);
        } finally {
            loadBtn.disabled = false;
        }
    }

    function renderTree(parentEl: HTMLElement, result: InspectResult, key: string, depth: number): void {
        parentEl.innerHTML = "";

        // Root header
        const header = document.createElement("div");
        header.style.cssText = `padding:var(--s-1) var(--s-2); color:var(--c-accent); font-weight:600; margin-left:${depth * 16}px`;
        header.textContent = `${result.className} @ ${result.handle}`;
        parentEl.appendChild(header);

        for (const f of result.fields) {
            const rowEl = createFieldRow(f, key, depth);
            parentEl.appendChild(rowEl);
        }
    }

    function createFieldRow(f: FieldNode, parentKey: string, depth: number): HTMLElement {
        const row = document.createElement("div");
        row.dataset.fieldName = f.name;
        row.dataset.parentKey = parentKey;
        row.dataset.kind = f.kind;
        row.style.cssText = `margin-left:${depth * 16}px`;

        const inner = document.createElement("div");
        inner.style.cssText = "display:flex; align-items:center; gap:var(--s-2); flex-wrap:wrap; padding:2px var(--s-2); border-radius:2px";
        inner.classList.add("insp-field-row");

        const nameSpan = document.createElement("span");
        nameSpan.className = "k";
        nameSpan.style.cssText = "min-width:140px; flex-shrink:0";
        nameSpan.textContent = f.name;

        const typeSpan = document.createElement("span");
        typeSpan.style.cssText = "font-size:10px; color:var(--c-label); min-width:80px; flex-shrink:0";
        typeSpan.textContent = f.typeName;

        inner.appendChild(nameSpan);
        inner.appendChild(typeSpan);

        if (f.kind === "primitive") {
            const valSpan = document.createElement("span");
            valSpan.className = "v";
            valSpan.style.flex = "1";
            valSpan.textContent = f.value ?? "";
            inner.appendChild(valSpan);

            // Watch button
            const watchBtn = document.createElement("button");
            watchBtn.className = "btn";
            watchBtn.style.cssText = "font-size:10px; padding:1px 6px";
            watchBtn.textContent = "📌 watch";
            watchBtn.addEventListener("click", () => { void doPinField(parentKey, f.name, f.typeName, watchBtn); });
            inner.appendChild(watchBtn);

            // Edit button
            const editBtn = document.createElement("button");
            editBtn.className = "btn";
            editBtn.style.cssText = "font-size:10px; padding:1px 6px";
            editBtn.textContent = "✎ edit";
            editBtn.addEventListener("click", () => { void doEditField(parentKey, f.name, valSpan); });
            inner.appendChild(editBtn);

        } else if (f.kind === "reference") {
            const valSpan = document.createElement("span");
            valSpan.style.cssText = "flex:1; color:var(--c-label)";
            valSpan.textContent = f.value ?? "";
            inner.appendChild(valSpan);

            const inspBtn = document.createElement("button");
            inspBtn.className = "btn";
            inspBtn.style.cssText = "font-size:10px; padding:1px 6px";
            inspBtn.textContent = "▸ inspect";
            inspBtn.addEventListener("click", () => {
                void doExpandRef(parentKey, f.name, depth + 1, row, inspBtn);
            });
            inner.appendChild(inspBtn);

        } else if (f.kind === "list") {
            const countLabel = f.listCount != null && f.listCount >= 0 ? `[${f.listCount}]` : "[?]";
            const valSpan = document.createElement("span");
            valSpan.style.cssText = "flex:1; color:var(--c-label)";
            valSpan.textContent = `List<${f.listElemType ?? "?"}>  ${countLabel}`;
            inner.appendChild(valSpan);

            const expBtn = document.createElement("button");
            expBtn.className = "btn";
            expBtn.style.cssText = "font-size:10px; padding:1px 6px";
            expBtn.textContent = "▸ expand";
            expBtn.addEventListener("click", () => {
                void doExpandList(parentKey, f.name, depth + 1, row, expBtn);
            });
            inner.appendChild(expBtn);

        } else if (f.kind === "null") {
            const valSpan = document.createElement("span");
            valSpan.style.cssText = "flex:1; color:var(--c-label); font-style:italic";
            valSpan.textContent = "null";
            inner.appendChild(valSpan);

        } else if (f.kind === "error") {
            const valSpan = document.createElement("span");
            valSpan.style.cssText = "flex:1; color:#e05252";
            valSpan.textContent = f.value ?? "<error>";
            inner.appendChild(valSpan);
        }

        row.appendChild(inner);
        return row;
    }

    async function doExpandRef(parentKey: string, fieldName: string, childDepth: number, rowEl: HTMLElement, btn: HTMLButtonElement): Promise<void> {
        // If already expanded, collapse
        const existingChild = rowEl.querySelector<HTMLElement>(".insp-subtree");
        if (existingChild) {
            existingChild.remove();
            btn.textContent = "▸ inspect";
            return;
        }
        btn.disabled = true;
        btn.textContent = "loading…";
        const autoKey = `${parentKey}.${fieldName}`;
        try {
            await rpcCall<string>("captureField", [parentKey, fieldName, autoKey]);
            const childResult = await rpcCall<InspectResult | null>("inspectInstance", [autoKey]);
            if (!childResult) {
                logRpcLine(`[inspector] captureField returned null for ${autoKey}`);
                btn.textContent = "▸ inspect";
                btn.disabled = false;
                return;
            }
            expandedRefs.set(autoKey, childResult);
            const subtree = document.createElement("div");
            subtree.className = "insp-subtree";
            renderTree(subtree, childResult, autoKey, childDepth);
            rowEl.appendChild(subtree);
            btn.textContent = "▾ collapse";
            btn.disabled = false;
        } catch (err) {
            logRpcLine(`[inspector] expand ref failed: ${String(err)}`);
            btn.textContent = "▸ inspect";
            btn.disabled = false;
        }
    }

    async function doExpandList(parentKey: string, fieldName: string, childDepth: number, rowEl: HTMLElement, btn: HTMLButtonElement): Promise<void> {
        // If already expanded, collapse
        const existingChild = rowEl.querySelector<HTMLElement>(".insp-listview");
        if (existingChild) {
            existingChild.remove();
            btn.textContent = "▸ expand";
            return;
        }
        btn.disabled = true;
        btn.textContent = "loading…";
        try {
            const items = await rpcCall<ListItem[]>("sliceList", [parentKey, fieldName, 0, 50]);
            expandedLists.set(`${parentKey}.${fieldName}`, items);
            const listView = document.createElement("div");
            listView.className = "insp-listview";
            listView.style.cssText = `margin-left:${childDepth * 16}px; display:flex; flex-direction:column; gap:1px`;
            for (const item of items) {
                const itemRow = document.createElement("div");
                itemRow.style.cssText = "display:flex; gap:var(--s-2); padding:1px var(--s-2); font-size:11px";
                const idxSpan = document.createElement("span");
                idxSpan.style.cssText = "color:var(--c-label); min-width:32px";
                idxSpan.textContent = `[${item.index}]`;
                const sumSpan = document.createElement("span");
                sumSpan.style.cssText = item.isReference ? "color:var(--c-accent)" : "";
                sumSpan.textContent = item.summary;
                itemRow.appendChild(idxSpan);
                itemRow.appendChild(sumSpan);
                listView.appendChild(itemRow);
            }
            if (items.length === 0) {
                const empty = document.createElement("div");
                empty.style.cssText = "padding:var(--s-1) var(--s-2); color:var(--c-label); font-style:italic; font-size:11px";
                empty.textContent = "(empty list)";
                listView.appendChild(empty);
            }
            rowEl.appendChild(listView);
            btn.textContent = "▾ collapse";
            btn.disabled = false;
        } catch (err) {
            logRpcLine(`[inspector] expand list failed: ${String(err)}`);
            btn.textContent = "▸ expand";
            btn.disabled = false;
        }
    }

    async function doPinField(parentKey: string, fieldName: string, _typeName: string, watchBtn: HTMLButtonElement): Promise<void> {
        const label = `${parentKey}.${fieldName}`;
        logRpcLine(`[inspector] pinField("instance", "${parentKey}", "${fieldName}")`);
        try {
            const result = await rpcCall<{ id: string; label: string }>("pinField", ["instance", parentKey, fieldName, label]);
            addWatchlistPin(result.id, result.label);
            watchBtn.textContent = "pinned";
            watchBtn.disabled = true;
        } catch (err) {
            logRpcLine(`[inspector] pin failed: ${String(err)}`);
        }
    }

    async function doEditField(parentKey: string, fieldName: string, valSpan: HTMLElement): Promise<void> {
        const newVal = prompt(`New value for ${parentKey}.${fieldName}:`);
        if (newVal === null) return;
        logRpcLine(`[inspector] writeField("${parentKey}", "${fieldName}", "${newVal}")`);
        try {
            await rpcCall("writeField", [parentKey, fieldName, parseScalarValue(newVal)]);
            // Refresh display value
            const current = await rpcCall<string>("readField", [parentKey, fieldName]);
            valSpan.textContent = String(current);
        } catch (err) {
            logRpcLine(`[inspector] writeField failed: ${String(err)}`);
        }
    }

    function buildMarkdown(): string {
        if (!currentResult) return "(no tree loaded)";
        const lines: string[] = [`## ${currentResult.className} @ ${currentResult.handle}`, ""];
        lines.push("| field | type | value |");
        lines.push("|---|---|---|");
        for (const f of currentResult.fields) {
            const val = f.kind === "list"
                ? `List<${f.listElemType ?? "?"}>  [${f.listCount ?? "?"}]`
                : (f.value ?? `(${f.kind})`);
            lines.push(`| ${f.name} | ${f.typeName} | ${val} |`);
        }
        return lines.join("\n");
    }

    loadBtn.addEventListener("click", () => {
        const key = keyEl.value.trim() || keyEl.placeholder;
        void doInspect(key);
    });

    copyBtn.addEventListener("click", () => {
        const md = buildMarkdown();
        void copyMarkdown(md);
    });

    keyEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            const key = keyEl.value.trim() || keyEl.placeholder;
            void doInspect(key);
        }
    });
}

function parseScalarValue(v: string): unknown {
    if (v === "true")  return true;
    if (v === "false") return false;
    if (v === "null")  return null;
    if (/^-?\d+$/.test(v))      return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
}
