// app/frontend/components/process-picker.ts
import { api } from "../core/api.js";

export async function showProcessPicker(): Promise<void> {
    return new Promise(async (resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.innerHTML = `
            <div class="modal">
                <h2>Pick a process to attach</h2>
                <input class="filter-mini" id="pp-filter" placeholder="Filter…" style="margin-bottom:8px;padding:6px 10px">
                <div class="proc-list" id="pp-list">Loading…</div>
                <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
                    <button class="pill" id="pp-cancel">Cancel</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const list = overlay.querySelector<HTMLElement>("#pp-list")!;
        const filter = overlay.querySelector<HTMLInputElement>("#pp-filter")!;
        let processes: { pid: number; name: string }[] = [];

        function render(): void {
            const q = filter.value.toLowerCase();
            const filtered = processes.filter((p) => p.name.toLowerCase().includes(q) || String(p.pid).includes(q));
            list.innerHTML = filtered.map((p) => `
                <div class="proc-row" data-pid="${p.pid}">
                    <span class="proc-pid">${p.pid}</span>
                    <span>${p.name}</span>
                </div>
            `).join("");
            list.querySelectorAll<HTMLElement>(".proc-row").forEach((r) => {
                r.addEventListener("click", async () => {
                    const pid = parseInt(r.dataset.pid!, 10);
                    list.innerHTML = `Attaching to pid=${pid}…`;
                    try {
                        await api.attach(pid);
                        document.body.removeChild(overlay);
                        resolve();
                    } catch (e) {
                        list.innerHTML = `<div style="color:var(--danger);padding:1em">${e instanceof Error ? e.message : String(e)}</div>`;
                    }
                });
            });
        }

        filter.addEventListener("input", render);
        overlay.querySelector("#pp-cancel")!.addEventListener("click", () => {
            document.body.removeChild(overlay);
            resolve();
        });

        try {
            const { processes: result } = await api.listProcesses();
            processes = result;
            render();
        } catch (e) {
            list.innerHTML = `<div style="color:var(--danger);padding:1em">${e instanceof Error ? e.message : String(e)}</div>`;
        }
    });
}
