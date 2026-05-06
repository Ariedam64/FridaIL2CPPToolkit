import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetFrame } from "../core/types.js";
import { mountNetworkDetail } from "./network-detail.js";
import { resolveClass, hasClassLabel, onLabelsChange } from "../core/label-resolver.js";

const RING_LIMIT = 5000;

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function previewFields(f: NetFrame): string {
    const parts: string[] = [];
    for (const fld of f.fields.slice(0, 4)) {
        parts.push(`${fld.name}: ${fld.preview}`);
    }
    const more = f.fields.length > 4 ? `, …+${f.fields.length - 4}` : "";
    return `{ ${parts.join(", ")}${more} }`;
}

// Frame ids are "f-<seq>" with decimal seq. Lex comparison breaks at seq >= 10.
function frameSeq(id: string): number {
    const n = parseInt(id.replace(/^f-/, ""), 10);
    return Number.isFinite(n) ? n : -1;
}

export interface StreamMountOptions {
    /** Called when the user clicks the Rename button in the detail side-panel. */
    onRename?(typeKey: { ns: string | null; className: string }): void;
    /** Inline filter input value, mirrored from the parent (sidebar filter). */
    sharedFilter?: { get(): string; onChange(cb: (v: string) => void): () => void };
}

export function mountNetworkStream(host: HTMLElement, opts: StreamMountOptions = {}): () => void {
    const ring: NetFrame[] = [];
    let paused = false;
    let filter = opts.sharedFilter?.get() ?? "";
    let lastSeenSeq = -1;

    host.innerHTML = `
        <div class="net-stream-toolbar" style="display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-strong)">
            <input class="mock-input" id="net-stream-filter" placeholder="filter substring…" style="flex:1;font-family:var(--font-code);font-size:11px">
            <button class="pill" id="net-stream-pause">Pause</button>
            <button class="pill" id="net-stream-clear">Clear</button>
            <button class="pill" id="net-stream-export">Export NDJSON</button>
            <span id="net-stream-count" style="color:var(--text-faint);font-size:11px">0 / ${RING_LIMIT}</span>
        </div>
        <div id="net-stream-list" style="flex:1;overflow-y:auto;padding:6px 12px;font-family:var(--font-code);font-size:11px"></div>
        <div id="net-stream-side-resizer" style="position:absolute;top:0;bottom:0;width:5px;cursor:col-resize;background:var(--border-strong);display:none;z-index:11"></div>
        <div id="net-stream-side" style="position:absolute;right:0;top:0;bottom:0;width:0;background:var(--bg-elevated);border-left:1px solid var(--border-strong);overflow-y:auto;transition:width 0.18s"></div>
    `;

    const list = host.querySelector<HTMLElement>("#net-stream-list")!;
    const countEl = host.querySelector<HTMLElement>("#net-stream-count")!;
    const sidePane = host.querySelector<HTMLElement>("#net-stream-side")!;
    const sideResizer = host.querySelector<HTMLElement>("#net-stream-side-resizer")!;
    const filterInput = host.querySelector<HTMLInputElement>("#net-stream-filter")!;
    const pauseBtn = host.querySelector<HTMLButtonElement>("#net-stream-pause")!;
    filterInput.value = filter;
    const offLabels = onLabelsChange(() => rerender());

    // Side-panel width: persisted, resizable via the left-edge handle.
    const SIDE_WIDTH_KEY = "frida.network.stream.side.width";
    let sideWidth = parseInt(localStorage.getItem(SIDE_WIDTH_KEY) ?? "400", 10);
    sideWidth = Math.max(280, Math.min(1200, sideWidth));

    function placeSideResizer(): void {
        // Resizer sits flush against the left edge of the side-panel.
        const w = parseFloat(sidePane.style.width || "0");
        if (w <= 0) { sideResizer.style.display = "none"; return; }
        sideResizer.style.display = "block";
        sideResizer.style.right = `${w}px`;
    }
    let dragging = false;
    sideResizer.addEventListener("pointerdown", (e) => {
        dragging = true;
        sideResizer.setPointerCapture(e.pointerId);
        // Disable the panel's transition during drag for smooth tracking.
        sidePane.style.transition = "none";
    });
    sideResizer.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const rect = host.getBoundingClientRect();
        // Width = distance from pointer to the right edge of the host.
        const w = Math.max(280, Math.min(1200, rect.right - e.clientX));
        sideWidth = w;
        sidePane.style.width = w + "px";
        placeSideResizer();
    });
    sideResizer.addEventListener("pointerup", (e) => {
        dragging = false;
        sideResizer.releasePointerCapture(e.pointerId);
        sidePane.style.transition = "width 0.18s";
        localStorage.setItem(SIDE_WIDTH_KEY, String(sideWidth));
    });

    function rerender(): void {
        const needle = filter.toLowerCase();
        const filtered = needle
            ? ring.filter((f) => `${f.typeKey.ns ?? ""}.${f.typeKey.className}`.toLowerCase().includes(needle))
            : ring;
        list.innerHTML = filtered.map((f) => `
            <div class="net-stream-row" data-id="${f.id}" style="display:flex;gap:10px;padding:2px 0;cursor:pointer">
                <span style="color:var(--text-faint)">${new Date(f.timestamp).toISOString().slice(11, 23)}</span>
                <span style="color:${f.direction === "in" ? "var(--success)" : "var(--danger)"}">${f.direction === "in" ? "←" : "→"}</span>
                <span style="color:var(--text-strong);min-width:160px">${escape(resolveClass(f.typeKey.className))}${hasClassLabel(f.typeKey.className) ? `<span style="color:var(--text-faint);font-size:9px"> [${escape(f.typeKey.className)}]</span>` : ""}</span>
                <span style="color:var(--text-faint);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(previewFields(f))}</span>
            </div>
        `).join("");
        countEl.textContent = `${ring.length} / ${RING_LIMIT}`;
        list.querySelectorAll<HTMLElement>(".net-stream-row").forEach((el) => {
            el.addEventListener("click", () => {
                const f = ring.find((x) => x.id === el.dataset.id);
                if (!f) return;
                openDetail(f);
            });
        });
        if (list.scrollTop + list.clientHeight + 50 >= list.scrollHeight) {
            list.scrollTop = list.scrollHeight;
        }
    }

    function openDetail(frame: NetFrame): void {
        sidePane.style.width = sideWidth + "px";
        placeSideResizer();
        mountNetworkDetail(sidePane, frame, {
            onRename: opts.onRename,
            onClose: () => {
                sidePane.style.width = "0";
                sidePane.innerHTML = "";
                placeSideResizer();
            },
        });
    }

    async function loadInitial(): Promise<void> {
        const r = await api.getNetworkFrames({ limit: 200 });
        ring.length = 0;
        ring.push(...r.frames);
        if (r.frames.length > 0) lastSeenSeq = frameSeq(r.frames[r.frames.length - 1].id);
        rerender();
    }

    const offFrame = subscribe("network-frame-added", (msg: { frame: NetFrame }) => {
        if (paused) return;
        const f = msg.frame;
        const seq = frameSeq(f.id);
        if (seq <= lastSeenSeq) return; // dedupe vs initial fetch
        ring.push(f);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        lastSeenSeq = seq;
        rerender();
    });
    const offCleared = subscribe("network-frames-cleared", () => {
        ring.length = 0;
        lastSeenSeq = -1;
        rerender();
    });

    filterInput.addEventListener("input", () => { filter = filterInput.value; rerender(); });
    const offShared = opts.sharedFilter?.onChange((v) => {
        filter = v;
        filterInput.value = v;
        rerender();
    });
    pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.textContent = paused ? "Resume" : "Pause";
    });
    host.querySelector<HTMLButtonElement>("#net-stream-clear")!.addEventListener("click", async () => {
        await api.clearNetworkFrames();
    });
    host.querySelector<HTMLButtonElement>("#net-stream-export")!.addEventListener("click", () => {
        const ndjson = ring.map((f) => JSON.stringify(f)).join("\n");
        const blob = new Blob([ndjson], { type: "application/x-ndjson" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `network-frames-${Date.now()}.ndjson`;
        a.click();
        URL.revokeObjectURL(url);
    });

    void loadInitial();

    return () => { offFrame(); offCleared(); offShared?.(); offLabels(); };
}
