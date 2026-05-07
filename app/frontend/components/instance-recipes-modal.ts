import { api } from "../core/api.js";
import type { InstanceRecipe } from "../core/types.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function openRecipesModal(): Promise<void> {
    const { recipes } = await api.listRecipes();
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;

    const renderBody = (rs: InstanceRecipe[]): string => {
        if (rs.length === 0) return `<div style="color:var(--text-faint);padding:16px;text-align:center">No recipes saved yet.</div>`;
        return rs.map((r) => `
            <div style="border-bottom:1px solid var(--border-strong);padding:8px 0" data-recipe="${escape(r.id)}">
                <div style="display:flex;justify-content:space-between;align-items:baseline">
                    <strong>${escape(r.name)}</strong>
                    <span style="font-size:10px;color:var(--text-faint)">${r.steps.length} steps · ${r.lastReplayedAt ? `last: ${r.lastReplayStatus}` : "never replayed"}</span>
                </div>
                ${r.description ? `<div style="font-size:11px;color:var(--text-faint);margin:4px 0">${escape(r.description)}</div>` : ""}
                <div style="display:flex;gap:6px;margin-top:6px">
                    <button class="ip-pill" data-replay="${escape(r.id)}">Replay</button>
                    <button class="ip-pill danger" data-delete="${escape(r.id)}">Delete</button>
                </div>
            </div>
        `).join("");
    };

    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:520px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">Recipes</h3>
            <div id="rec-list">${renderBody(recipes)}</div>
            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-close>Close</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLButtonElement>("[data-close]")?.addEventListener("click", () => overlay.remove());

    overlay.querySelectorAll<HTMLButtonElement>("[data-replay]").forEach((b) => {
        b.addEventListener("click", async () => {
            const id = b.dataset.replay!;
            const result = await api.replayRecipe(id);
            const failedSteps = result.steps.filter((s) => !s.ok);
            const msg = `Replay ${result.finalStatus.toUpperCase()}: ${result.steps.length - failedSteps.length}/${result.steps.length} steps OK${failedSteps.length > 0 ? "\n\nFailures:\n" + failedSteps.map((s) => `  step ${s.stepIndex} (${s.op}): ${s.error}`).join("\n") : ""}`;
            alert(msg);
            overlay.remove();
        });
    });

    overlay.querySelectorAll<HTMLButtonElement>("[data-delete]").forEach((b) => {
        b.addEventListener("click", async () => {
            const id = b.dataset.delete!;
            if (!confirm("Delete this recipe?")) return;
            await api.deleteRecipe(id);
            const refreshed = await api.listRecipes();
            const list = overlay.querySelector<HTMLElement>("#rec-list");
            if (list) list.innerHTML = renderBody(refreshed.recipes);
        });
    });
}
