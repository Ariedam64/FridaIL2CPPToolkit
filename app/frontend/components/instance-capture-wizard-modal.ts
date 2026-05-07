import { api } from "../core/api.js";
import type { InstanceRecipeStep, CapturedInstanceLite } from "../core/types.js";

interface WizardOptions {
    prefillClassName?: string;
    instances: CapturedInstanceLite[];
    onSubmitted(): void;
}

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function openCaptureWizard(opts: WizardOptions): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;
    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:480px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">New capture</h3>
            <div style="display:flex;gap:4px;margin-bottom:12px">
                <button class="ip-pill" data-tab="gc">via GC</button>
                <button class="ip-pill" data-tab="hook">via Hook</button>
                <button class="ip-pill" data-tab="chain">chain</button>
            </div>
            <div id="wiz-form"></div>
            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-cancel>Cancel</button>
                <button class="ip-pill" data-submit style="background:var(--accent);color:var(--bg)">Capture</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let activeTab: "gc" | "hook" | "chain" = "gc";

    function renderForm(): void {
        const f = overlay.querySelector<HTMLElement>("#wiz-form");
        if (!f) return;
        if (activeTab === "gc") {
            f.innerHTML = `
                <label>className<input class="ip-input" id="wiz-cn" value="${escape(opts.prefillClassName ?? "")}" style="width:100%"></label><br><br>
                <label>index<input class="ip-input" id="wiz-idx" value="0" style="width:100%"></label><br><br>
                <label>asKey (registry name)<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
            const cnInput = overlay.querySelector<HTMLInputElement>("#wiz-cn");
            const keyInput = overlay.querySelector<HTMLInputElement>("#wiz-key");
            const sync = () => { if (keyInput && cnInput && !keyInput.dataset.touched) keyInput.value = cnInput.value.toLowerCase(); };
            cnInput?.addEventListener("input", sync); sync();
            keyInput?.addEventListener("input", () => { if (keyInput) keyInput.dataset.touched = "1"; });
        } else if (activeTab === "hook") {
            f.innerHTML = `
                <label>className<input class="ip-input" id="wiz-cn" value="${escape(opts.prefillClassName ?? "")}" style="width:100%"></label><br><br>
                <label>tickMethod (e.g., Update)<input class="ip-input" id="wiz-tm" value="Update" style="width:100%"></label><br><br>
                <label>timeoutMs<input class="ip-input" id="wiz-ms" value="10000" style="width:100%"></label><br><br>
                <label>asKey<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
        } else {
            const ownerOpts = opts.instances.map((i) => `<option value="${escape(i.key)}">${escape(i.key)} (${escape(i.className)})</option>`).join("");
            f.innerHTML = `
                <label>ownerKey<select class="ip-input" id="wiz-owner" style="width:100%">${ownerOpts}</select></label><br><br>
                <label>chain type<select class="ip-input" id="wiz-chain-kind" style="width:100%">
                    <option value="field">field</option>
                    <option value="list">list element</option>
                    <option value="method">method return</option>
                </select></label><br><br>
                <div id="wiz-chain-extras"></div>
                <label>asKey<input class="ip-input" id="wiz-key" value="" style="width:100%"></label>
            `;
            const renderExtras = () => {
                const kind = (overlay.querySelector<HTMLSelectElement>("#wiz-chain-kind")?.value ?? "field");
                const x = overlay.querySelector<HTMLElement>("#wiz-chain-extras");
                if (!x) return;
                if (kind === "field") {
                    x.innerHTML = `<label>fieldName<input class="ip-input" id="wiz-fn" value="" style="width:100%"></label><br><br>`;
                } else if (kind === "list") {
                    x.innerHTML = `<label>listFieldName<input class="ip-input" id="wiz-fn" value="" style="width:100%"></label><br><br><label>index<input class="ip-input" id="wiz-idx" value="0" style="width:100%"></label><br><br>`;
                } else {
                    x.innerHTML = `<label>methodName<input class="ip-input" id="wiz-mn" value="" style="width:100%"></label><br><br><label>args (JSON array)<input class="ip-input" id="wiz-args" value="[]" style="width:100%"></label><br><br>`;
                }
            };
            overlay.querySelector<HTMLSelectElement>("#wiz-chain-kind")?.addEventListener("change", renderExtras);
            renderExtras();
        }
    }
    renderForm();

    overlay.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
        b.addEventListener("click", () => { activeTab = b.dataset.tab as "gc" | "hook" | "chain"; renderForm(); });
    });

    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => overlay.remove());

    overlay.querySelector<HTMLButtonElement>("[data-submit]")?.addEventListener("click", async () => {
        let payload: InstanceRecipeStep | null = null;
        const v = (id: string) => overlay.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value ?? "";
        try {
            if (activeTab === "gc") {
                payload = { op: "captureViaGC", className: v("wiz-cn"), index: parseInt(v("wiz-idx"), 10), asKey: v("wiz-key") };
            } else if (activeTab === "hook") {
                payload = { op: "captureViaHook", className: v("wiz-cn"), tickMethod: v("wiz-tm"), timeoutMs: parseInt(v("wiz-ms"), 10), asKey: v("wiz-key") };
            } else {
                const kind = v("wiz-chain-kind");
                if (kind === "field") {
                    payload = { op: "captureFieldValue", ownerKey: v("wiz-owner"), fieldName: v("wiz-fn"), asKey: v("wiz-key") };
                } else if (kind === "list") {
                    payload = { op: "captureListElement", ownerKey: v("wiz-owner"), listFieldName: v("wiz-fn"), index: parseInt(v("wiz-idx"), 10), asKey: v("wiz-key") };
                } else {
                    payload = { op: "captureMethodReturn", ownerKey: v("wiz-owner"), methodName: v("wiz-mn"), args: JSON.parse(v("wiz-args") || "[]"), asKey: v("wiz-key") };
                }
            }
            await api.captureInstance(payload!);
            overlay.remove();
            opts.onSubmitted();
        } catch (err) {
            alert(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
}
