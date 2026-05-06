// app/frontend/pages/hooks.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { StoredHook } from "../core/types.js";

export function mountHooksPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0;display:flex;align-items:center;gap:12px">Hooks
                <button class="pill" id="h-add">+ Add hook</button>
                <button class="pill" id="h-clear" style="margin-left:auto">Uninstall all</button>
            </h2>
            <div id="h-list">Loading…</div>
        </div>
    `;
    host.style.flex = "1";
    const list = host.querySelector<HTMLElement>("#h-list")!;
    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        const { hooks } = await api.getHooks();
        if (hooks.length === 0) {
            list.innerHTML = `<div style="color:var(--text-faint)">No hooks defined.</div>`;
            return;
        }
        list.innerHTML = hooks.map((h: StoredHook) => `
            <div style="padding:10px 14px;background:var(--bg-tile);border:1px solid var(--border-strong);border-radius:8px;margin-bottom:6px;display:flex;align-items:center;gap:10px">
                <span style="font-family:var(--font-code);font-size:11px">${escape(h.spec.className)}.${escape(h.spec.methodName)}</span>
                <span class="kind-tag method" style="padding:2px 7px;border-radius:4px;font-size:9px;background:rgba(167,139,250,0.15);color:var(--method)">[${h.spec.template}]</span>
                <span style="color:${h.installedHookId ? "var(--success)" : "var(--text-faint)"};font-size:10px">${h.installedHookId ? "● installed" : "○ disarmed"}</span>
                <span style="margin-left:auto;display:flex;gap:4px">
                    ${h.installedHookId
                        ? `<button class="icon-btn-mini" data-uninstall="${h.id}">Uninstall</button>`
                        : `<button class="icon-btn-mini" data-install="${h.id}">Install</button>`
                    }
                    <button class="icon-btn-mini" data-remove="${h.id}" style="color:var(--danger)">Delete</button>
                </span>
            </div>
        `).join("");
        list.querySelectorAll<HTMLButtonElement>("[data-install]").forEach((b) => b.addEventListener("click", () => api.installHook(b.dataset.install!)));
        list.querySelectorAll<HTMLButtonElement>("[data-uninstall]").forEach((b) => b.addEventListener("click", () => api.uninstallHook(b.dataset.uninstall!)));
        list.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) => b.addEventListener("click", () => api.removeHook(b.dataset.remove!)));
    }

    host.querySelector("#h-add")!.addEventListener("click", async () => {
        const cls = prompt("Class fullName (e.g. Core.UILogic.Inventory):");
        if (!cls) return;
        const m = prompt(`Method name on ${cls}:`);
        if (!m) return;
        const t = prompt("Template (log/log-stack/noop/force-return):", "log");
        if (!t) return;
        try {
            const { stored } = await api.addHook({ template: t as any, className: cls, methodName: m });
            await api.installHook(stored.id);
        } catch (e) {
            alert(`Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    });
    host.querySelector("#h-clear")!.addEventListener("click", async () => {
        if (!confirm("Uninstall all hooks?")) return;
        await api.clearAllHooks();
    });

    subscribe("hook-store-change", refresh);
    void refresh();
}
