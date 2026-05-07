import { api } from "../core/api.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function openInstancePicker(className: string, instanceLines: string[]): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;

    const items = instanceLines.map((l) => {
        const m = l.match(/^\[(\d+)\]\s+(.+?)@(0x[0-9a-fA-F]+)/);
        return m ? { index: parseInt(m[1], 10), className: m[2], handle: m[3], raw: l } : null;
    }).filter((x): x is { index: number; className: string; handle: string; raw: string } => x !== null);

    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:640px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">Pick an instance of ${escape(className.split(".").pop() ?? className)}</h3>
            <p style="font-size:11px;color:var(--text-faint);margin:0 0 12px">${items.length} live instance${items.length === 1 ? "" : "s"} found via GC. Field previews loading… click one to capture it.</p>
            <div id="pick-list">
                ${items.map((it) => `
                    <button class="ip-pill" data-index="${it.index}" style="display:block;width:100%;text-align:left;margin-bottom:6px;padding:8px 10px;font-family:var(--font-code);font-size:12px">
                        <div>
                            <span style="color:var(--text-faint)">[${it.index}]</span>
                            <span style="margin-left:6px">${escape(it.className)}</span>
                            <span style="color:var(--text-faint);margin-left:6px">${escape(it.handle)}</span>
                        </div>
                        <div data-preview="${it.index}" style="font-size:10px;color:var(--text-faint);margin-top:3px;padding-left:24px">loading…</div>
                    </button>
                `).join("")}
            </div>
            <div style="display:flex;gap:6px;margin-top:14px;justify-content:flex-end">
                <button class="ip-pill" data-cancel>Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector<HTMLButtonElement>("[data-cancel]")?.addEventListener("click", () => overlay.remove());

    // Click → capture this index
    overlay.querySelectorAll<HTMLButtonElement>("[data-index]").forEach((b) => {
        b.addEventListener("click", async () => {
            const idx = parseInt(b.dataset.index!, 10);
            const asKey = `${(className.split(".").pop() ?? className).toLowerCase()}_${idx}`;
            try {
                await api.captureInstance({ op: "captureViaGC", className, index: idx, asKey });
                overlay.remove();
                location.hash = `#/instances?picked=${encodeURIComponent(asKey)}`;
            } catch (err) {
                alert(`Capture failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        });
    });

    // Fire previews in parallel; update each row as it lands.
    for (const it of items) {
        void api.previewInstance(className, it.index, 8).then((res) => {
            const slot = overlay.querySelector<HTMLElement>(`[data-preview="${it.index}"]`);
            if (!slot) return;
            if (res.fields.length === 0) {
                slot.textContent = "(no scalar fields)";
                return;
            }
            slot.innerHTML = res.fields.map((f) => {
                // Strip <X>k__BackingField wrapper for readability
                const cleanName = f.name.replace(/^<(.+)>k__BackingField$/, "$1");
                return `<span style="color:var(--text-strong)">${escape(cleanName)}</span>=<span style="color:var(--syntax-name)">${escape(f.preview)}</span>`;
            }).join(", ");
        }).catch(() => {
            const slot = overlay.querySelector<HTMLElement>(`[data-preview="${it.index}"]`);
            if (slot) slot.textContent = "(preview failed)";
        });
    }
}
