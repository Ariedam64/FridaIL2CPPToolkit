import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import type { NetFrame, NetField } from "../core/types.js";
import { mountNetworkDetail } from "./network-detail.js";
import { resolveClass, resolveField, hasClassLabel, onLabelsChange } from "../core/label-resolver.js";
import { muteStore } from "./network-mute-store.js";

// =============================================================================
// Frame relabeler — ADD friendly labels alongside obfuscated names for the
// export, so the .ndjson keeps the raw capture data intact (cross-reference
// with the live game stays possible) while making the user's renames visible.
//
// Nested children inherit class context from their parent: a `nested` field's
// preview encodes the inner class name ("→ jfi (7 fields)"), which becomes
// the lookup key for that subtree's field renames.
// =============================================================================
function parseNestedClassName(preview: string): string | null {
    const m = preview.match(/^→\s+(\S+)/);
    return m ? m[1] : null;
}
function annotateFields(fields: NetField[], classContext: string): NetField[] {
    return fields.map((f) => {
        const out: NetField & { label?: string; classLabel?: string } = { ...f };

        // Add a `label` field next to the obfuscated `name` when a rename exists.
        if (classContext && !f.name.startsWith("[")) {
            const friendly = resolveField(classContext, f.name);
            if (friendly !== f.name) out.label = friendly;
        }

        // Resolve the inner class for nested fields, so children get the right
        // lookup context AND we can attach `classLabel` here when renamed.
        let childContext = classContext;
        if (f.kind === "nested") {
            const inner = parseNestedClassName(f.preview);
            if (inner) {
                childContext = inner;
                const friendly = resolveClass(inner);
                if (friendly !== inner) out.classLabel = friendly;
            }
        }

        if (f.children) out.children = annotateFields(f.children, childContext);
        return out;
    });
}
function annotateFrame(f: NetFrame): NetFrame & { typeKey: NetFrame["typeKey"] & { classLabel?: string } } {
    const obfClass = f.typeKey.className;
    const friendly = resolveClass(obfClass);
    const newTypeKey: NetFrame["typeKey"] & { classLabel?: string } = { ...f.typeKey };
    if (friendly !== obfClass) newTypeKey.classLabel = friendly;
    return { ...f, typeKey: newTypeKey, fields: annotateFields(f.fields, obfClass) };
}

const RING_LIMIT = 5000;
const MAX_RECORDINGS = 5;
const RECORDINGS_KEY = "frida.network.recordings";

interface Recording { id: string; label: string; startTs: number; endTs: number; frames: NetFrame[]; }
function loadRecordings(): Recording[] {
    try {
        const raw = localStorage.getItem(RECORDINGS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch { return []; }
}
function saveRecordings(list: Recording[]): void {
    try { localStorage.setItem(RECORDINGS_KEY, JSON.stringify(list)); } catch {}
}

const PAUSED_KEY = "network-stream-paused";
function loadPaused(): boolean {
    try { return localStorage.getItem(PAUSED_KEY) === "1"; } catch { return false; }
}
function savePaused(p: boolean): void {
    try { localStorage.setItem(PAUSED_KEY, p ? "1" : "0"); } catch {}
}

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
    // Pause is persisted across remounts: leaving the network panel and
    // coming back (or navigating to another plugin) used to silently resume.
    let paused = loadPaused();
    let filter = opts.sharedFilter?.get() ?? "";
    let lastSeenSeq = -1;
    let showMuted = false;
    let recording: { startTs: number; frames: NetFrame[] } | null = null;
    let viewingRecord: Recording | null = null;
    let recordings = loadRecordings();

    host.innerHTML = `
        <div class="net-stream-toolbar" style="display:flex;gap:6px;align-items:center;padding:6px 10px;border-bottom:1px solid var(--border-strong);flex-wrap:wrap">
            <input class="mock-input" id="net-stream-filter" placeholder="filter substring…" style="flex:1;min-width:160px;font-family:var(--font-code);font-size:11px">
            <button class="pill" id="net-stream-pause">Pause</button>
            <button class="pill" id="net-stream-record" title="Record a sequence">● Record</button>
            <button class="pill" id="net-stream-mutes" title="Show/hide muted classes">Show muted</button>
            <button class="pill" id="net-stream-clear">Clear</button>
            <button class="pill" id="net-stream-export">Export NDJSON</button>
            <span id="net-stream-count" style="color:var(--text-faint);font-size:11px">0 / ${RING_LIMIT}</span>
            <select id="net-stream-viewmode" title="View recorded sequence" style="background:var(--bg-tile);color:var(--text-strong);border:1px solid var(--border-strong);border-radius:4px;font-family:var(--font-code);font-size:11px;padding:3px 6px"></select>
            <button class="pill" id="net-stream-delrec" title="Delete current recording" style="display:none">×</button>
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
    const recordBtn = host.querySelector<HTMLButtonElement>("#net-stream-record")!;
    const mutesBtn = host.querySelector<HTMLButtonElement>("#net-stream-mutes")!;
    const viewSelect = host.querySelector<HTMLSelectElement>("#net-stream-viewmode")!;
    const delRecBtn = host.querySelector<HTMLButtonElement>("#net-stream-delrec")!;
    filterInput.value = filter;
    const offLabels = onLabelsChange(() => rerender());
    const offMute = muteStore.onChange(() => rerender());

    function refreshViewSelect(): void {
        const opts = ['<option value="live">Live stream</option>'];
        for (const r of recordings) {
            opts.push(`<option value="${r.id}">${escape(r.label)} (${r.frames.length})</option>`);
        }
        viewSelect.innerHTML = opts.join("");
        viewSelect.value = viewingRecord ? viewingRecord.id : "live";
        delRecBtn.style.display = viewingRecord ? "" : "none";
    }
    refreshViewSelect();

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
        const source = viewingRecord ? viewingRecord.frames : ring;
        let filtered = needle
            ? source.filter((f) => {
                const obf = `${f.typeKey.ns ?? ""}.${f.typeKey.className}`.toLowerCase();
                if (obf.includes(needle)) return true;
                // Also match against the renamed label so users searching
                // "BidHouse" can find frames whose obfuscated name is jej/jfk/etc.
                const friendly = resolveClass(f.typeKey.className).toLowerCase();
                return friendly !== f.typeKey.className.toLowerCase() && friendly.includes(needle);
            })
            : source;
        let mutedCount = 0;
        if (!showMuted) {
            const before = filtered.length;
            filtered = filtered.filter((f) => !muteStore.has(f.typeKey.className));
            mutedCount = before - filtered.length;
        }
        list.innerHTML = filtered.map((f) => `
            <div class="net-stream-row" data-id="${f.id}" style="display:flex;gap:10px;padding:2px 0;cursor:pointer">
                <span style="color:var(--text-faint)">${new Date(f.timestamp).toISOString().slice(11, 23)}</span>
                <span style="color:${f.direction === "in" ? "var(--success)" : "var(--danger)"}">${f.direction === "in" ? "←" : "→"}</span>
                <span style="color:var(--text-strong);min-width:160px">${escape(resolveClass(f.typeKey.className))}${hasClassLabel(f.typeKey.className) ? `<span style="color:var(--text-faint);font-size:9px"> [${escape(f.typeKey.className)}]</span>` : ""}</span>
                <span style="color:var(--text-faint);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escape(previewFields(f))}</span>
            </div>
        `).join("");
        const ctxLabel = viewingRecord ? `[REC] ${filtered.length}/${source.length}` : `${ring.length} / ${RING_LIMIT}`;
        const mutedLabel = mutedCount > 0 ? ` · ${mutedCount} muted hidden` : (muteStore.size() > 0 ? ` · ${muteStore.size()} class${muteStore.size()>1?"es":""} muted` : "");
        const recLabel = recording ? ` · ● recording (${recording.frames.length})` : "";
        countEl.textContent = `${ctxLabel}${mutedLabel}${recLabel}`;
        list.querySelectorAll<HTMLElement>(".net-stream-row").forEach((el) => {
            el.addEventListener("click", () => {
                const f = source.find((x) => x.id === el.dataset.id);
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
        const f = msg.frame;
        const seq = frameSeq(f.id);
        if (seq <= lastSeenSeq) return; // dedupe vs initial fetch
        if (recording) recording.frames.push(f);
        if (paused) return;
        ring.push(f);
        if (ring.length > RING_LIMIT) ring.splice(0, ring.length - RING_LIMIT);
        lastSeenSeq = seq;
        if (!viewingRecord) rerender();
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
        savePaused(paused);
    });
    // Initial label match the persisted state.
    if (paused) pauseBtn.textContent = "Resume";
    mutesBtn.addEventListener("click", () => {
        showMuted = !showMuted;
        mutesBtn.textContent = showMuted ? "Hide muted" : "Show muted";
        rerender();
    });
    recordBtn.addEventListener("click", () => {
        if (!recording) {
            recording = { startTs: Date.now(), frames: [] };
            recordBtn.textContent = "■ Stop";
            recordBtn.style.color = "var(--danger)";
            rerender();
        } else {
            const endTs = Date.now();
            const label = window.prompt(
                `Recording done — ${recording.frames.length} frames in ${((endTs - recording.startTs)/1000).toFixed(1)}s. Name it:`,
                `rec ${new Date(recording.startTs).toLocaleTimeString()}`,
            );
            if (label) {
                const rec: Recording = {
                    id: "r" + recording.startTs,
                    label,
                    startTs: recording.startTs,
                    endTs,
                    frames: recording.frames.slice(),
                };
                recordings.unshift(rec);
                if (recordings.length > MAX_RECORDINGS) recordings = recordings.slice(0, MAX_RECORDINGS);
                saveRecordings(recordings);
                refreshViewSelect();
            }
            recording = null;
            recordBtn.textContent = "● Record";
            recordBtn.style.color = "";
            rerender();
        }
    });
    viewSelect.addEventListener("change", () => {
        const v = viewSelect.value;
        viewingRecord = v === "live" ? null : (recordings.find((r) => r.id === v) ?? null);
        delRecBtn.style.display = viewingRecord ? "" : "none";
        rerender();
    });
    delRecBtn.addEventListener("click", () => {
        if (!viewingRecord) return;
        if (!confirm(`Delete recording "${viewingRecord.label}" ?`)) return;
        recordings = recordings.filter((r) => r.id !== viewingRecord!.id);
        saveRecordings(recordings);
        viewingRecord = null;
        refreshViewSelect();
        rerender();
    });
    host.querySelector<HTMLButtonElement>("#net-stream-clear")!.addEventListener("click", async () => {
        await api.clearNetworkFrames();
    });
    host.querySelector<HTMLButtonElement>("#net-stream-export")!.addEventListener("click", () => {
        // Export what's currently visible: viewed recording (or live ring) minus
        // muted classes when the user is in "hide muted" mode.
        const source = viewingRecord ? viewingRecord.frames : ring;
        const frames = showMuted
            ? source
            : source.filter((f) => !muteStore.has(f.typeKey.className));
        const ndjson = frames.map((f) => JSON.stringify(annotateFrame(f))).join("\n");
        const blob = new Blob([ndjson], { type: "application/x-ndjson" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const slug = viewingRecord
            ? viewingRecord.label.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "rec"
            : "live";
        a.download = `network-frames-${slug}-${Date.now()}.ndjson`;
        a.click();
        URL.revokeObjectURL(url);
    });

    void loadInitial();

    return () => { offFrame(); offCleared(); offShared?.(); offLabels(); offMute(); };
}
