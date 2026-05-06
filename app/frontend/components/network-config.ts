import { api } from "../core/api.js";
import type { NetSerializerEntry } from "../core/types.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function showNetworkConfig(opts: { onSaved?(): void } = {}): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:flex;align-items:center;justify-content:center";
    const modal = document.createElement("div");
    modal.style.cssText = "background:var(--bg-base);border:1px solid var(--border-strong);border-radius:8px;width:680px;max-width:95vw;max-height:85vh;display:flex;flex-direction:column";
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let entries: NetSerializerEntry[] = [];

    function rerender(): void {
        modal.innerHTML = `
            <div style="padding:14px 18px;border-bottom:1px solid var(--border-strong);display:flex;justify-content:space-between;align-items:center">
                <h3 style="margin:0">Configure network capture</h3>
                <button class="icon-btn-mini" id="net-cfg-close">✕</button>
            </div>
            <div style="flex:1;overflow-y:auto;padding:14px 18px">
                ${entries.length === 0 ? `<div style="color:var(--text-faint)">No entries yet — click "Add manual" to designate a serializer method.</div>` : ""}
                ${entries.map((e, i) => `
                    <div style="padding:10px;background:var(--bg-tile);border:1px solid var(--border-strong);border-radius:6px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
                        <span style="color:${e.disabled ? "var(--text-faint)" : (e.stale ? "var(--danger)" : "var(--success)")}">${e.disabled ? "○" : (e.stale ? "❌" : "●")}</span>
                        <span style="font-family:var(--font-code);font-size:11px;flex:1">
                            <span style="color:${e.direction === "send" ? "var(--danger)" : "var(--success)"}">${e.direction.toUpperCase()}</span>
                            ${escape(e.ns ? e.ns + "." : "")}<strong>${escape(e.className)}</strong>.${escape(e.methodName)}
                            <span style="color:var(--text-faint)">${escape(e.methodSignature)}</span>
                        </span>
                        <span style="color:var(--text-faint);font-size:10px">${e.source}</span>
                        <button class="icon-btn-mini" data-toggle="${i}">${e.disabled ? "Enable" : "Disable"}</button>
                        <button class="icon-btn-mini" data-remove="${i}" style="color:var(--danger)">Remove</button>
                    </div>
                `).join("")}
            </div>
            <div id="net-cfg-add" style="border-top:1px solid var(--border-strong);padding:14px 18px"></div>
            <div style="border-top:1px solid var(--border-strong);padding:10px 18px;display:flex;gap:8px;justify-content:flex-end">
                <button class="pill" id="net-cfg-add-btn">+ Add manual</button>
                <button class="pill" id="net-cfg-save">Save</button>
            </div>
        `;
        modal.querySelector<HTMLButtonElement>("#net-cfg-close")!.addEventListener("click", () => overlay.remove());
        modal.querySelector<HTMLButtonElement>("#net-cfg-save")!.addEventListener("click", async () => {
            try {
                await api.putSerializerConfig(entries);
                overlay.remove();
                opts.onSaved?.();
            } catch (err) {
                alert(`Save failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
        modal.querySelector<HTMLButtonElement>("#net-cfg-add-btn")!.addEventListener("click", () => renderAddForm());
        modal.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.dataset.toggle);
                entries[i].disabled = !entries[i].disabled;
                rerender();
            });
        });
        modal.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => {
            b.addEventListener("click", () => {
                const i = Number(b.dataset.remove);
                entries.splice(i, 1);
                rerender();
            });
        });
    }

    function renderAddForm(): void {
        const host = modal.querySelector<HTMLElement>("#net-cfg-add")!;
        host.innerHTML = `
            <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:8px 12px;align-items:center;font-size:11px">
                <label>Direction</label>
                <select id="add-dir" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                    <option value="send">send (out)</option>
                    <option value="recv">recv (in)</option>
                </select>
                <label>Param index</label>
                <input id="add-param" type="number" value="0" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px;width:60px">
                <label>Namespace</label>
                <input id="add-ns" placeholder="(empty for root)" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Class</label>
                <input id="add-class" placeholder="ecu" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Method</label>
                <input id="add-method" placeholder="xbe" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
                <label>Signature</label>
                <input id="add-sig" placeholder="(IMessage):Void" style="font-family:var(--font-code);padding:3px 6px;background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px">
            </div>
            <div style="margin-top:10px;display:flex;gap:8px">
                <button class="pill" id="add-validate">Validate</button>
                <button class="pill" id="add-add">Add to list</button>
                <span id="add-status" style="color:var(--text-faint);font-size:10px;align-self:center"></span>
            </div>
        `;

        function readForm(): NetSerializerEntry {
            const dir = (host.querySelector<HTMLSelectElement>("#add-dir")!.value === "recv") ? "recv" : "send";
            const ns = host.querySelector<HTMLInputElement>("#add-ns")!.value.trim();
            return {
                source: "manual",
                direction: dir,
                ns: ns === "" ? null : ns,
                className: host.querySelector<HTMLInputElement>("#add-class")!.value.trim(),
                methodName: host.querySelector<HTMLInputElement>("#add-method")!.value.trim(),
                methodSignature: host.querySelector<HTMLInputElement>("#add-sig")!.value.trim(),
                paramIndex: Number(host.querySelector<HTMLInputElement>("#add-param")!.value),
                addedAt: new Date().toISOString(),
            };
        }

        host.querySelector<HTMLButtonElement>("#add-validate")!.addEventListener("click", async () => {
            const entry = readForm();
            const status = host.querySelector<HTMLElement>("#add-status")!;
            status.textContent = "validating…";
            try {
                const r = await api.rpc<{ valid: boolean; reason?: string; actualSignature?: string }>(
                    "validateSerializerEntry", [entry],
                );
                if (r.result.valid) {
                    status.textContent = `✓ valid (signature: ${r.result.actualSignature ?? "?"})`;
                    status.style.color = "var(--success)";
                } else {
                    status.textContent = `✗ ${r.result.reason}`;
                    status.style.color = "var(--danger)";
                }
            } catch (err) {
                status.textContent = `error: ${err instanceof Error ? err.message : String(err)}`;
                status.style.color = "var(--danger)";
            }
        });

        host.querySelector<HTMLButtonElement>("#add-add")!.addEventListener("click", () => {
            const entry = readForm();
            if (!entry.className || !entry.methodName) {
                alert("Class + method are required");
                return;
            }
            entries.push(entry);
            rerender();
        });
    }

    async function init(): Promise<void> {
        const r = await api.getSerializerConfig();
        entries = r.config.entries.slice();
        rerender();
    }

    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    void init();
}
