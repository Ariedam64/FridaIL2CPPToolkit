// Connection panel — process picker, renders into sidebar "processes" tab.
import { listProcesses, attach } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";

interface Proc { pid: number; name: string; }

let currentPid: number | null = null;

/** Subscribe to attach/detach events and update the status pill + buttons.
 *  Call once at boot from main.ts. */
export function wireStatusAndButtons(
    statusEl: HTMLElement,
    btnDetach: HTMLButtonElement,
    btnReload: HTMLButtonElement,
): void {
    function setAttached(info: Proc | null): void {
        currentPid = info ? info.pid : null;
        if (info) {
            statusEl.className = "status-pill on";
            statusEl.textContent = `${info.name} · ${info.pid}`;
            btnDetach.disabled = false;
            btnReload.disabled = false;
        } else {
            statusEl.className = "status-pill";
            statusEl.textContent = "not attached";
            btnDetach.disabled = true;
            btnReload.disabled = true;
        }
    }

    onWsEvent((ev) => {
        if (ev.type === "hello")    setAttached(ev.attached);
        else if (ev.type === "attached") setAttached({ pid: ev.pid, name: ev.name });
        else if (ev.type === "detached") setAttached(null);
    });
}

/** Render the process list into container. Safe to call multiple times (e.g. on tab switch). */
export function mountConnection(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; gap:var(--s-2); margin-bottom:var(--s-3); padding:var(--s-3)">
        <input class="input" id="conn-q" placeholder="filter by name…" style="flex:1">
        <button class="btn" id="conn-refresh" title="refresh">↻</button>
      </div>
      <div id="conn-proclist" style="font-family:var(--font-mono); font-size:12px; padding:0 var(--s-3)">loading…</div>
    `;

    const q       = container.querySelector("#conn-q")       as HTMLInputElement;
    const list    = container.querySelector("#conn-proclist") as HTMLElement;
    const refresh = container.querySelector("#conn-refresh")  as HTMLButtonElement;

    let procs: Proc[] = [];

    async function refreshProcs(): Promise<void> {
        list.textContent = "loading…";
        try {
            procs = await listProcesses();
            renderList();
        } catch (e) {
            list.innerHTML = `<span style="color:var(--err)">${String(e)}</span>`;
        }
    }

    function renderList(): void {
        const filter = q.value.toLowerCase();
        const shown  = filter ? procs.filter(p => p.name.toLowerCase().includes(filter)) : procs;
        if (shown.length === 0) { list.textContent = "(no match)"; return; }
        list.innerHTML = shown.map(p => `
          <div class="proc-row" data-pid="${p.pid}"
               style="display:flex; align-items:center; justify-content:space-between;
                      padding:5px var(--s-2); cursor:pointer;
                      border-bottom:1px solid var(--border-soft);
                      background:${p.pid === currentPid ? "var(--surface-2)" : "transparent"}">
            <span style="color:var(--ink-primary)">${p.name}</span>
            <span class="tag${p.pid === currentPid ? " live" : ""}">${p.pid}</span>
          </div>
        `).join("");
    }

    list.addEventListener("click", async (e) => {
        const row = (e.target as HTMLElement).closest(".proc-row") as HTMLElement | null;
        if (!row) return;
        const pid = Number(row.dataset.pid);
        if (pid === currentPid) return;
        try {
            await attach(pid);
        } catch (err) {
            console.error("[connection] attach failed", err);
        }
    });

    q.addEventListener("input", renderList);
    refresh.addEventListener("click", () => void refreshProcs());

    // Re-render list when attach state changes (to highlight current process)
    onWsEvent((ev) => {
        if (ev.type === "attached" || ev.type === "detached" || ev.type === "hello") {
            renderList();
        }
    });

    void refreshProcs();
}
