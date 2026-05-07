import type { PluginPageModule, PluginPageContext } from "../../../frontend/core/plugin-types";

const SUBS = ["map", "items", "state"] as const;
type Sub = typeof SUBS[number];
const DEFAULT_SUB: Sub = "map";

const mod: PluginPageModule = {
    mount(host: HTMLElement, ctx: PluginPageContext): void {
        const requested = ctx.currentSubTab;
        const sub: Sub = (requested && (SUBS as readonly string[]).includes(requested) ? requested : DEFAULT_SUB) as Sub;

        host.innerHTML = `
            <div style="display:flex;flex-direction:column;flex:1;min-height:0">
                <div data-testid="dofus-subnav" style="display:flex;gap:8px;padding:8px;border-bottom:1px solid #333">
                    ${SUBS.map((s) => `
                        <button data-sub="${s}" style="padding:4px 10px;background:${s === sub ? "#1e3a8a" : "transparent"};color:${s === sub ? "#fff" : "inherit"};border:1px solid #333;border-radius:4px;cursor:pointer">${s}</button>
                    `).join("")}
                </div>
                <div data-testid="dofus-sub-host" style="flex:1;overflow:auto;padding:16px;color:#888">
                    <p>Dofus plugin — <strong>${sub}</strong> sub-page (placeholder).</p>
                    <p>Profile: <code>${ctx.profile.gameName} / ${ctx.profile.buildId.slice(0, 8)}</code></p>
                    <p style="margin-top:24px;font-style:italic">The actual ${sub} feature ships in a follow-up sub-project.</p>
                </div>
            </div>
        `;

        host.querySelectorAll<HTMLButtonElement>("[data-sub]").forEach((btn) => {
            btn.addEventListener("click", () => ctx.setSubTab(btn.dataset.sub!));
        });
    },
};

export default mod;
