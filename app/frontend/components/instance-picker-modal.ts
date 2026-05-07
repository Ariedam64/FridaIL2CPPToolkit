import { api } from "../core/api.js";

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Pick which live instance of `className` to capture, given the lines returned
 * by the agent's `listInstances(className, max)` (e.g., "[0] PlayerInventory@0x123").
 * On selection, captures via GC at the chosen index and navigates to the
 * Instances page.
 */
export function openInstancePicker(className: string, instanceLines: string[]): void {
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:100;display:flex;align-items:center;justify-content:center`;

    // Parse "[N] ClassName@0xHANDLE" lines.
    const items = instanceLines.map((l) => {
        const m = l.match(/^\[(\d+)\]\s+(.+?)@(0x[0-9a-fA-F]+)/);
        return m ? { index: parseInt(m[1], 10), className: m[2], handle: m[3], raw: l } : null;
    }).filter((x): x is { index: number; className: string; handle: string; raw: string } => x !== null);

    overlay.innerHTML = `
        <div style="background:var(--bg);border:1px solid var(--border-strong);border-radius:6px;padding:18px;width:520px;max-height:80vh;overflow-y:auto">
            <h3 style="margin-top:0">Pick an instance of ${escape(className.split(".").pop() ?? className)}</h3>
            <p style="font-size:11px;color:var(--text-faint);margin:0 0 12px">${items.length} live instances found via GC. Click one to capture it.</p>
            <div id="pick-list">
                ${items.map((it) => `
                    <button class="ip-pill" data-index="${it.index}" style="display:block;width:100%;text-align:left;margin-bottom:4px;padding:6px 10px;font-family:var(--font-code);font-size:12px">
                        <span style="color:var(--text-faint)">[${it.index}]</span>
                        <span style="margin-left:6px">${escape(it.className)}</span>
                        <span style="color:var(--text-faint);margin-left:6px">${escape(it.handle)}</span>
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
}
