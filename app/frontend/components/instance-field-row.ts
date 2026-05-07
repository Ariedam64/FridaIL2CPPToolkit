import { api } from "../core/api.js";
import { icons } from "../core/icons.js";
import type { FieldReadLite } from "../core/types.js";

export interface FieldRowOptions {
    instanceKey: string;
    field: FieldReadLite;
    readOnly: boolean;
    onDrillDown(field: FieldReadLite): void;
    onWriteSucceeded(): void;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderFieldRow(opts: FieldRowOptions): HTMLElement {
    const { field: f, instanceKey, readOnly } = opts;
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.alignItems = "baseline";
    div.style.gap = "8px";
    div.style.padding = "3px 0";
    div.style.fontFamily = "var(--font-code)";
    div.style.fontSize = "12px";

    const name = `<span style="min-width:140px;color:var(--text-strong)">${escape(f.name)}</span>`;
    const type = `<span style="min-width:60px;color:var(--syntax-type);font-size:10px">${escape(f.kind)}</span>`;

    const editable = !readOnly && f.isWritable && (f.kind === "scalar" || f.kind === "string" || f.kind === "enum");
    const drillable = (f.kind === "nested" && f.nestedClass) || (f.kind === "array" && (f.arrayLength ?? 0) > 0);

    let valueHtml = `<span style="flex:1;color:var(--syntax-name)">${escape(f.preview)}</span>`;
    if (editable) {
        const initial = f.rawValue !== undefined ? String(f.rawValue) : "";
        valueHtml = `
            <input class="ip-input" data-edit="${escape(f.name)}" value="${escape(initial)}" style="flex:1">
            <button class="ip-pill" data-save="${escape(f.name)}">Save</button>
        `;
    } else if (drillable) {
        const target = f.kind === "nested" ? `→ ${escape(f.nestedClass!)}` : `[${f.arrayLength} items]`;
        valueHtml = `
            <span style="flex:1;color:var(--syntax-name)">${target}</span>
            <button class="ip-pill" data-drill="${escape(f.name)}">${icons.chevronRight(10)} Drill</button>
        `;
    }

    div.innerHTML = name + type + valueHtml;

    const saveBtn = div.querySelector<HTMLButtonElement>(`[data-save]`);
    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            const input = div.querySelector<HTMLInputElement>(`[data-edit]`);
            if (!input) return;
            const raw = input.value;
            let value: unknown = raw;
            if (typeof f.rawValue === "number") value = Number(raw);
            else if (typeof f.rawValue === "boolean") value = raw === "true" || raw === "1";
            try {
                await api.writeInstanceField(instanceKey, f.name, value);
                div.style.background = "rgba(34,197,94,0.15)";
                setTimeout(() => { div.style.background = ""; }, 800);
                opts.onWriteSucceeded();
            } catch (err) {
                alert(`Write failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    }

    const drillBtn = div.querySelector<HTMLButtonElement>(`[data-drill]`);
    if (drillBtn) drillBtn.addEventListener("click", () => opts.onDrillDown(f));

    return div;
}
