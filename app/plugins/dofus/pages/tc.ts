// Trade Center test surface — minimal UI to fire each TradeCenterActions
// method and inspect the response. Plumbed onto the dofus plugin's "tc"
// sub-tab. Not pretty, just functional.

import type { PluginPageContext } from "../../../frontend/core/plugin-types";

interface CallResult { ok: boolean; [k: string]: unknown }

async function call(path: string, body: Record<string, unknown>): Promise<CallResult> {
    const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
}

function row(host: HTMLElement, label: string, fields: { name: string; placeholder: string; default?: string }[], action: (vals: Record<string, string>) => Promise<CallResult>): void {
    // Each row is its own <form> so Enter in any input submits, and clicking
    // the type=submit button reads input values at the moment of submit (no
    // browser focus timing weirdness).
    const form = document.createElement("form");
    form.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid #333;border-radius:6px;background:#0f0f0f";
    const head = document.createElement("strong");
    head.textContent = label;
    head.style.cssText = "min-width:90px;color:#9bd";
    form.appendChild(head);

    const inputs: Record<string, HTMLInputElement> = {};
    for (const f of fields) {
        const input = document.createElement("input");
        input.type = "text";
        input.name = f.name;
        input.placeholder = f.placeholder;
        if (f.default !== undefined) input.value = f.default;
        input.style.cssText = "flex:1;min-width:80px;padding:4px 8px;background:#0a0a0a;border:1px solid #333;border-radius:4px;color:#eee;font-family:monospace;font-size:12px";
        form.appendChild(input);
        inputs[f.name] = input;
    }
    const btn = document.createElement("button");
    btn.type = "submit";
    btn.textContent = "Go";
    btn.style.cssText = "padding:4px 12px;background:#1e3a8a;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:13px";
    form.appendChild(btn);
    host.appendChild(form);

    form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const vals: Record<string, string> = {};
        for (const k of Object.keys(inputs)) vals[k] = inputs[k].value.trim();
        btn.disabled = true; btn.textContent = "…";
        const t0 = performance.now();
        try {
            const result = await action(vals);
            const ms = Math.round(performance.now() - t0);
            output.textContent = `// ${label} — ${ms}ms\n` + JSON.stringify(result, null, 2);
        } catch (e) {
            output.textContent = `// ${label} — ERROR\n${(e as Error).message}`;
        } finally {
            btn.disabled = false; btn.textContent = "Go";
        }
    });
}

let output: HTMLElement;

export async function mountTradeCenterTest(host: HTMLElement, _ctx: PluginPageContext): Promise<void> {
    host.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;padding:12px;gap:10px";
    host.innerHTML = "";

    const grid = document.createElement("div");
    grid.style.cssText = "display:flex;flex-direction:column;gap:8px";
    host.appendChild(grid);

    row(grid, "Buy now", [
        { name: "itemId",   placeholder: "itemId (e.g. 1455=Aile Scarafeuille Bleu)" },
        { name: "quantity", placeholder: "qty (1/10/100/1000)" },
    ], (v) => call("/api/dofus/tc/buy-now", { itemId: +v.itemId, quantity: +v.quantity }));

    row(grid, "Open", [
        { name: "interactionId", placeholder: "interactionId (map elementId)", default: "522694" },
        { name: "extra",         placeholder: "extra (ecou)",                  default: "8746" },
    ], (v) => call("/api/dofus/tc/open", { interactionId: +v.interactionId, extra: +v.extra }));

    row(grid, "Select", [
        { name: "typeId", placeholder: "typeId (e.g. 38=Bois, 104=Ailes, 78=Runes)" },
    ], (v) => call("/api/dofus/tc/select", { typeId: +v.typeId }));

    row(grid, "Fetch", [
        { name: "itemId", placeholder: "itemId (e.g. 473=Bois Châtaignier)" },
    ], (v) => call("/api/dofus/tc/fetch", { itemId: +v.itemId }));

    row(grid, "Buy", [
        { name: "auctionId", placeholder: "auctionId" },
        { name: "quantity",  placeholder: "qty (1/10/100/1000)" },
        { name: "price",     placeholder: "price (matching tier)" },
    ], (v) => call("/api/dofus/tc/buy", { auctionId: +v.auctionId, quantity: +v.quantity, price: +v.price }));

    const outWrap = document.createElement("div");
    outWrap.style.cssText = "display:flex;flex-direction:column;flex:1;min-height:0;border:1px solid #333;border-radius:6px;overflow:hidden";
    const outHead = document.createElement("div");
    outHead.textContent = "Result";
    outHead.style.cssText = "padding:6px 10px;background:#181818;color:#888;font-size:12px;border-bottom:1px solid #333";
    output = document.createElement("pre");
    output.textContent = "// run an action above";
    output.style.cssText = "margin:0;padding:10px;flex:1;overflow:auto;font-family:monospace;font-size:12px;color:#cde;background:#0a0a0a;white-space:pre-wrap;word-break:break-all";
    outWrap.appendChild(outHead);
    outWrap.appendChild(output);
    host.appendChild(outWrap);
}
