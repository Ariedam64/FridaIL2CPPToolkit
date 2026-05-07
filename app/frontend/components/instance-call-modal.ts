import { api } from "../core/api.js";

export interface CallModalOptions {
    instanceKey: string;
    methodName: string;
    parameters: Array<{ name: string; typeName: string }>;
    onResult(result: string): void;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function openCallModal(opts: CallModalOptions): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;
    const paramsHtml = opts.parameters.length === 0
        ? `<div style="color:var(--text-faint);font-size:11px">no parameters</div>`
        : opts.parameters.map((p) => `
            <label style="display:block;margin-bottom:8px"><span style="display:inline-block;min-width:100px">${escape(p.name)}</span><span style="font-size:10px;color:var(--text-faint)"> (${escape(p.typeName)})</span><br><input class="ip-input" data-param="${escape(p.name)}" style="width:100%"></label>
        `).join("");
    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:480px">
            <h3 style="margin-top:0">Call ${escape(opts.instanceKey)}.${escape(opts.methodName)}()</h3>
            <div style="margin-bottom:14px">${paramsHtml}</div>
            <div style="background:rgba(245,158,11,0.10);border:1px solid var(--warning);padding:8px;border-radius:4px;font-size:11px;margin-bottom:14px">
                ⚠ Calling this method executes game code. Risk: client may crash, server may desync.
            </div>
            <div style="display:flex;gap:6px;justify-content:flex-end">
                <button class="ip-pill" data-cancel>Cancel</button>
                <button class="ip-pill" data-call style="background:var(--warning);color:var(--bg)">Call</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => overlay.remove());
    overlay.querySelector<HTMLButtonElement>("[data-call]")?.addEventListener("click", async () => {
        const args = opts.parameters.map((p) => {
            const v = overlay.querySelector<HTMLInputElement>(`[data-param="${p.name}"]`)?.value ?? "";
            if (p.typeName.includes("Int") || p.typeName.includes("Single") || p.typeName.includes("Double")) return Number(v);
            if (p.typeName === "System.Boolean") return v === "true";
            return v;
        });
        try {
            const r = await api.callInstanceMethod(opts.instanceKey, opts.methodName, args);
            opts.onResult(r.result);
            overlay.remove();
        } catch (err) {
            alert(`Call failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
