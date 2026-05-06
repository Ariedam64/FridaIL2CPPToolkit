// app/frontend/pages/migrations.ts
import { api } from "../core/api.js";
import { icons } from "../core/icons.js";

export function mountMigrationsPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0">Migrations</h2>
            <div id="mig-content">Loading…</div>
        </div>
    `;
    host.style.flex = "1";
    const content = host.querySelector<HTMLElement>("#mig-content")!;

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        try {
            const { result } = await api.getMigrations();
            content.innerHTML = `
                <h3>Auto (${result.auto.length})</h3>
                ${result.auto.map((m: any) => `<div style="padding:6px 10px;background:var(--bg-tile);border-radius:6px;margin-bottom:4px">${icons.check()} ${escape(m.label)}: ${escape(m.oldObf)} → ${escape(m.newObf)}</div>`).join("") || '<div style="color:var(--text-faint)">none</div>'}
                <h3>Review (${result.review.length})</h3>
                ${result.review.map((m: any) => `
                    <div style="padding:8px 12px;background:var(--bg-tile);border-radius:6px;margin-bottom:4px">
                        <div>${escape(m.label)}: <code>${escape(m.oldObf)}</code></div>
                        ${m.candidates.map((c: any) => `
                            <button class="icon-btn-mini" data-accept="${escape(m.oldObf)}" data-new="${escape(c.newObf)}" style="margin-top:4px">→ ${escape(c.newObf)} (${c.score.toFixed(2)})</button>
                        `).join("")}
                        <button class="icon-btn-mini" style="margin-left:8px;color:var(--danger)" data-reject="${escape(m.oldObf)}">Reject all</button>
                    </div>
                `).join("") || '<div style="color:var(--text-faint)">none</div>'}
                <h3>Lost (${result.lost.length})</h3>
                ${result.lost.map((m: any) => `<div style="padding:6px 10px;color:var(--danger)">${icons.x()} ${escape(m.label)}: ${escape(m.oldObf)}</div>`).join("") || '<div style="color:var(--text-faint)">none</div>'}
            `;
            content.querySelectorAll<HTMLButtonElement>("[data-accept]").forEach((b) => {
                b.addEventListener("click", async () => {
                    await api.acceptMigration(b.dataset.accept!, b.dataset.new!);
                    refresh();
                });
            });
            content.querySelectorAll<HTMLButtonElement>("[data-reject]").forEach((b) => {
                b.addEventListener("click", async () => {
                    await api.rejectMigration(b.dataset.reject!);
                    refresh();
                });
            });
        } catch (e) {
            content.innerHTML = `<div style="color:var(--danger)">${escape(String(e))}</div>`;
        }
    }

    void refresh();
}
