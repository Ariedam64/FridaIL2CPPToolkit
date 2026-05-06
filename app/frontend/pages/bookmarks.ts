// app/frontend/pages/bookmarks.ts
import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";

export function mountBookmarksPage(host: HTMLElement): void {
    host.innerHTML = `
        <div style="flex:1;padding:24px;overflow-y:auto">
            <h2 style="margin-top:0">Bookmarks</h2>
            <div id="bm-list"></div>
        </div>
    `;
    host.style.flex = "1";
    const list = host.querySelector<HTMLElement>("#bm-list")!;

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

    async function refresh(): Promise<void> {
        try {
            const { bookmarks } = await api.getAnnotations();
            const labels = await api.getLabels();
            if (bookmarks.length === 0) {
                list.innerHTML = `<div style="color:var(--text-faint)">No bookmarks yet.</div>`;
                return;
            }
            list.innerHTML = bookmarks.map((k: any) => {
                const friendly = k.kind === "class" ? labels.classes[k.className]?.label : null;
                const display = friendly
                    ? `<span style="font-weight:500">${escape(friendly)}</span> <span style="color:var(--text-faint);font-family:var(--font-code);font-size:11px">[${escape(k.className)}]</span>`
                    : escape(k.className);
                return `
                    <div style="padding:8px 12px;border-radius:8px;background:var(--bg-tile);margin-bottom:6px;display:flex;align-items:center;gap:8px">
                        <span>${icons.star()}</span>
                        <span style="flex:1">${display}</span>
                        <button class="icon-btn-mini" data-open="${escape(k.className)}">Open</button>
                        <button class="icon-btn-mini" data-toggle='${JSON.stringify(k).replace(/'/g, "&#039;")}'>${icons.x()}</button>
                    </div>
                `;
            }).join("");
            list.querySelectorAll<HTMLButtonElement>("[data-open]").forEach((b) => {
                b.addEventListener("click", () => {
                    location.hash = `#/explorer`;
                    setTimeout(() => {
                        window.dispatchEvent(new CustomEvent("frida:open-class", { detail: b.dataset.open }));
                    }, 100);
                });
            });
            list.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((b) => {
                b.addEventListener("click", async () => {
                    const k = JSON.parse(b.dataset.toggle!);
                    await api.toggleBookmark(k);
                });
            });
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger)">${escape(String(e))}</div>`;
        }
    }

    subscribe("annotation-change", refresh);
    subscribe("profile-attached", refresh);
    void refresh();
}
