// Socket panel — network capture with scrolling dedicated log.
import { rpcCall } from "../lib/rpc.js";
import { onWsEvent } from "../lib/ws.js";
import { logRpcLine, logRpcResult } from "./logs.js";

// Manual aliases persist across re-renders via localStorage (user edits)
const socketAliases: Record<string, string> = (() => {
    try { return JSON.parse(localStorage.getItem("socketAliases") || "{}") as Record<string, string>; }
    catch { return {}; }
})();
function saveAliases(): void { localStorage.setItem("socketAliases", JSON.stringify(socketAliases)); }

// Auto aliases loaded from the game's preset (.toolkit-data/presets/<slug>.json)
// Refreshed on each panel mount + when the attach state changes.
let presetAliases: Record<string, string> = {};
// For each known class: map backing-field names (obfuscated) → readable field names.
// Looked up during entry rendering to show `mapId = 191106052` instead of `<efdk>k__BackingField = …`.
let presetFieldMap: Record<string, Record<string, string>> = {};

// Raw preset body — kept around so snapshot / refresh can POST back updates.
interface PresetEntry {
    readable?: string;
    direction?: "in" | "out";
    note?: string;
    signature?: string;
    fingerprint?: string;
    fields?: Record<string, string>;
}
interface Preset {
    slug?: string;
    processName?: string;
    note?: string;
    signatureDepth?: number;
    protocolMap?: Record<string, PresetEntry>;
}
let presetBody: Preset | null = null;

async function loadPresetAliases(): Promise<void> {
    try {
        const res = await fetch("/api/presets/auto");
        if (!res.ok) { presetAliases = {}; presetFieldMap = {}; presetBody = null; return; }
        const preset = await res.json() as Preset | null;
        presetBody = preset;
        presetAliases = {};
        presetFieldMap = {};
        if (preset?.protocolMap) {
            for (const [cls, info] of Object.entries(preset.protocolMap)) {
                if (info?.readable) presetAliases[cls] = info.readable;
                if (info?.fields) presetFieldMap[cls] = info.fields;
            }
        }
    } catch { presetAliases = {}; presetFieldMap = {}; presetBody = null; }
}

async function savePreset(preset: Preset): Promise<void> {
    const slug = preset.slug;
    if (!slug) throw new Error("preset has no slug");
    const res = await fetch(`/api/presets/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preset),
    });
    if (!res.ok) throw new Error(`savePreset: HTTP ${res.status}`);
}

/**
 * Strip the C# auto-property backing-field wrapping to expose the readable getter name.
 *   `<efdk>k__BackingField` → `efdk`.
 * Then look up a preset mapping if available.
 */
function prettyFieldName(cls: string, name: string): string {
    const m = name.match(/^<([^>]+)>k__BackingField$/);
    const base = m ? m[1] : name;
    return presetFieldMap[cls]?.[base] ?? base;
}

let mountWsUnsub: (() => void) | null = null;

interface SocketPayload {
    direction?: string;
    cls?: string;
    name?: string;
    fullName?: string;
    ts?: number;
    fields?: Record<string, unknown>;
}

async function runAction(action: string, args: unknown[]): Promise<void> {
    logRpcLine(`[rpc] ${action}(${args.map(a => JSON.stringify(a)).join(", ")})`);
    try {
        const result = await rpcCall(action, args);
        logRpcResult(action, result);
    } catch (err) {
        logRpcLine(`[rpc] ${action} failed: ${String(err)}`);
    }
}

// --- export / import aliases as JSON file ---------------------------------
function exportAliases(): void {
    const blob = new Blob([JSON.stringify(socketAliases, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `socket-aliases-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importAliases(file: File, onDone: () => void): void {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const raw = reader.result as string;
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                for (const [k, v] of Object.entries(parsed)) {
                    if (typeof v === "string") socketAliases[k] = v;
                }
                saveAliases();
                onDone();
            }
        } catch (e) {
            logRpcLine(`[socket] alias import failed: ${String(e)}`);
        }
    };
    reader.readAsText(file);
}

export function renderSocket(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3); height:100%">

        <div class="section-header">outgoing — hook IMessage send <span class="meta">↑ class.method(msg)</span></div>
        <div class="action-row-out" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="sendClass"  value="ecu" placeholder="send class"  style="flex:1">
          <input class="input" data-arg="sendMethod" value="xbe" placeholder="send method" style="flex:1">
          <button class="btn primary" data-action="startNetworkCapture">start</button>
          <button class="btn"         data-action="stopNetworkCapture">stop</button>
        </div>

        <div class="section-header">incoming — hook decoder output <span class="meta">↓ decode(_, msg, output) → last element unwrapped</span></div>
        <div class="action-row-in" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="recvClass"   value="fzk"    placeholder="recv class"   style="flex:1">
          <input class="input" data-arg="recvMethod"  value="Decode" placeholder="recv method"  style="flex:1">
          <input class="input" data-arg="outputIndex" value="2"      placeholder="output arg idx" style="max-width:60px">
          <button class="btn primary" data-action="startIncomingCapture">start</button>
          <button class="btn"         data-action="stopIncomingCapture">stop</button>
        </div>

        <div class="section-header">
          capture log
          <span class="meta" id="socket-stats-bar">0 events · 0 types · 0 ev/s</span>
        </div>

        <div style="display:flex; gap:var(--s-2); align-items:center; flex-wrap:wrap">
          <input class="input" id="socket-filter-input" placeholder="filter by class (click a row's name to toggle)…" style="flex:1; min-width:180px">
          <label style="display:flex;align-items:center;gap:4px;color:var(--ink-muted);font-size:11.5px;cursor:pointer">
            <input type="checkbox" id="socket-autoscroll-cb" checked style="accent-color:var(--accent)"> auto-scroll
          </label>
          <label style="display:flex;align-items:center;gap:4px;color:var(--ink-muted);font-size:11.5px;cursor:pointer">
            <input type="checkbox" id="socket-group-cb" checked style="accent-color:var(--accent)"> group dupes
          </label>
          <button class="btn" id="socket-pause-btn"  title="freeze live updates (events still captured)">⏸ pause</button>
          <button class="btn" id="socket-clear-btn">clear</button>
          <button class="btn" id="socket-snapshot-btn" title="compute current protobuf signatures for every preset entry and save them — do this once on a known-good build">📸 snapshot sigs</button>
          <button class="btn" id="socket-refresh-btn"  title="re-bind readable→currentCls by matching stored signatures against the running process — use after a Dofus update when obf names changed">🔄 refresh</button>
          <button class="btn" id="socket-export-btn" title="download aliases as JSON">export aliases</button>
          <button class="btn" id="socket-import-btn" title="merge aliases from JSON file">import aliases</button>
          <input type="file" id="socket-import-file" accept="application/json" style="display:none">
        </div>

        <div id="socket-log-inner"
             style="flex:1; overflow:auto; font-family:var(--font-mono); font-size:11.5px;
                    border:1px solid var(--border-soft); border-radius:var(--r-md);
                    background:var(--surface-inset)">
        </div>

      </div>
    `;

    const socketLogEl      = container.querySelector("#socket-log-inner")      as HTMLElement;
    const filterInput      = container.querySelector("#socket-filter-input")    as HTMLInputElement;
    const autoscrollCb     = container.querySelector("#socket-autoscroll-cb")   as HTMLInputElement;
    const groupCb          = container.querySelector("#socket-group-cb")        as HTMLInputElement;
    const clearBtn         = container.querySelector("#socket-clear-btn")       as HTMLButtonElement;
    const pauseBtn         = container.querySelector("#socket-pause-btn")       as HTMLButtonElement;
    const exportBtn        = container.querySelector("#socket-export-btn")      as HTMLButtonElement;
    const importBtn        = container.querySelector("#socket-import-btn")      as HTMLButtonElement;
    const importFile       = container.querySelector("#socket-import-file")     as HTMLInputElement;
    const snapshotBtn      = container.querySelector("#socket-snapshot-btn")    as HTMLButtonElement;
    const refreshBtn       = container.querySelector("#socket-refresh-btn")     as HTMLButtonElement;
    const statsBar         = container.querySelector("#socket-stats-bar")       as HTMLElement;

    let socketFilter = "";
    let paused = false;
    const pauseBuffer: SocketPayload[] = [];     // events received while paused
    const pauseBufferMax = 2000;

    // Rolling stats
    const eventTimes: number[] = [];   // event receive timestamps (ms) for rate computation
    const classCounts = new Map<string, number>();
    let totalEvents = 0;
    let lastEntry: {
        el: HTMLElement;
        cls: string;
        count: number;
        countEl: HTMLElement;
        tsEl: HTMLElement;
    } | null = null;

    function updateStats(): void {
        const now = Date.now();
        // prune events older than 5s for rate
        while (eventTimes.length && now - eventTimes[0] > 5000) eventTimes.shift();
        const rate = (eventTimes.length / 5).toFixed(1);
        statsBar.textContent = `${totalEvents} events · ${classCounts.size} types · ${rate} ev/s`;
    }
    setInterval(updateStats, 500);

    clearBtn.addEventListener("click", () => {
        socketLogEl.innerHTML = "";
        lastEntry = null;
    });

    function applyFilter(): void {
        socketLogEl.querySelectorAll<HTMLElement>(".socket-entry").forEach(el => {
            const match = !socketFilter || new RegExp(socketFilter, "i").test(el.dataset.cls ?? "");
            el.classList.toggle("filtered-out", !match);
        });
    }

    filterInput.addEventListener("input", () => {
        socketFilter = filterInput.value.trim();
        applyFilter();
    });

    pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.textContent = paused ? `▶ resume${pauseBuffer.length ? ` (${pauseBuffer.length} buffered)` : ""}` : "⏸ pause";
        pauseBtn.classList.toggle("primary", paused);
        if (!paused) {
            // flush buffer
            const drained = pauseBuffer.splice(0, pauseBuffer.length);
            for (const p of drained) pushSocketEvent(p);
        }
    });

    exportBtn.addEventListener("click", exportAliases);
    importBtn.addEventListener("click", () => importFile.click());

    // --- snapshot: compute signatures for every preset entry and save ------
    snapshotBtn.addEventListener("click", async () => {
        if (!presetBody?.protocolMap) {
            logRpcLine("[socket] no preset loaded — attach first");
            return;
        }
        const depth = presetBody.signatureDepth ?? 3;
        const entries = Object.entries(presetBody.protocolMap);
        snapshotBtn.disabled = true;
        snapshotBtn.textContent = `📸 snapshotting 0/${entries.length}…`;
        let ok = 0, missed = 0;
        try {
            for (let i = 0; i < entries.length; i++) {
                const [cls, info] = entries[i];
                snapshotBtn.textContent = `📸 snapshotting ${i + 1}/${entries.length}…`;
                try {
                    const sig = await rpcCall<{ cls: string; signature: string; fingerprint: string } | null>(
                        "extractProtobufSignature", [cls, depth],
                    );
                    if (sig?.signature) {
                        info.signature = sig.signature;
                        info.fingerprint = sig.fingerprint;
                        ok++;
                    } else {
                        missed++;
                    }
                } catch { missed++; }
            }
            await savePreset(presetBody);
            logRpcLine(`[socket] snapshot saved — ${ok} signatures, ${missed} missed`);
        } catch (e) {
            logRpcLine(`[socket] snapshot failed: ${String(e)}`);
        } finally {
            snapshotBtn.disabled = false;
            snapshotBtn.textContent = "📸 snapshot sigs";
        }
    });

    // --- refresh: match stored signatures against running process ---------
    refreshBtn.addEventListener("click", async () => {
        if (!presetBody?.protocolMap) {
            logRpcLine("[socket] no preset loaded — attach first");
            return;
        }
        const depth = presetBody.signatureDepth ?? 3;
        // Build `{ readable: signature }` from the preset. Skip entries missing a sig.
        const req: Record<string, string> = {};
        const readableToOldCls: Record<string, string> = {};
        for (const [cls, info] of Object.entries(presetBody.protocolMap)) {
            if (info?.readable && info.signature) {
                req[info.readable] = info.signature;
                readableToOldCls[info.readable] = cls;
            }
        }
        const want = Object.keys(req).length;
        if (want === 0) {
            logRpcLine("[socket] no signatures in preset — run 📸 snapshot first");
            return;
        }
        refreshBtn.disabled = true;
        refreshBtn.textContent = "🔄 matching…";
        try {
            const matches = await rpcCall<Record<string, { readable: string; signature: string; fingerprint: string; ambiguous?: true }>>(
                "matchSignatures", [req, depth],
            );
            // Rebuild protocolMap with the new obf cls names as keys, preserving
            // readable/direction/fields/note from the old entry (looked up via readable).
            const oldByReadable: Record<string, { oldCls: string; entry: PresetEntry }> = {};
            for (const [oldCls, entry] of Object.entries(presetBody.protocolMap)) {
                if (entry?.readable) oldByReadable[entry.readable] = { oldCls, entry };
            }
            const newMap: Record<string, PresetEntry> = {};
            let renamed = 0, stable = 0, ambiguous = 0;
            for (const [newCls, m] of Object.entries(matches)) {
                const prev = oldByReadable[m.readable];
                if (!prev) continue;
                if (m.ambiguous) ambiguous++;
                if (newCls !== prev.oldCls) renamed++; else stable++;
                newMap[newCls] = {
                    ...prev.entry,
                    signature: m.signature,
                    fingerprint: m.fingerprint,
                };
                delete oldByReadable[m.readable];
            }
            // Keep unmatched entries at their old keys — user can inspect them.
            const orphaned: string[] = [];
            for (const [readable, { oldCls, entry }] of Object.entries(oldByReadable)) {
                newMap[oldCls] = entry;
                orphaned.push(readable);
            }
            presetBody.protocolMap = newMap;
            await savePreset(presetBody);
            await loadPresetAliases();
            socketLogEl.querySelectorAll<HTMLElement>(".socket-entry").forEach(refreshEntryDisplay);
            const parts = [`${stable} stable`, `${renamed} renamed`];
            if (ambiguous) parts.push(`${ambiguous} ambiguous`);
            if (orphaned.length) parts.push(`${orphaned.length} orphaned: ${orphaned.slice(0, 5).join(", ")}${orphaned.length > 5 ? "…" : ""}`);
            logRpcLine(`[socket] refresh · ${parts.join(" · ")}`);
        } catch (e) {
            logRpcLine(`[socket] refresh failed: ${String(e)}`);
        } finally {
            refreshBtn.disabled = false;
            refreshBtn.textContent = "🔄 refresh";
        }
    });

    importFile.addEventListener("change", () => {
        const f = importFile.files?.[0];
        if (!f) return;
        importAliases(f, () => {
            // refresh all entries' aliased display
            socketLogEl.querySelectorAll<HTMLElement>(".socket-entry").forEach(refreshEntryDisplay);
            logRpcLine(`[socket] aliases imported (${Object.keys(socketAliases).length} total)`);
        });
        importFile.value = "";
    });

    // Start/stop buttons — outgoing row
    const outRow = container.querySelector(".action-row-out") as HTMLElement;
    outRow.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn || !btn.dataset.action) return;
        const action = btn.dataset.action;
        const inputs = [...outRow.querySelectorAll<HTMLInputElement>("[data-arg]")];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });
        void runAction(action, [vals["sendClass"] || "ecu", vals["sendMethod"] || "xbe"]);
    });

    // Start/stop buttons — incoming row
    const inRow = container.querySelector(".action-row-in") as HTMLElement;
    inRow.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn || !btn.dataset.action) return;
        const action = btn.dataset.action;
        const inputs = [...inRow.querySelectorAll<HTMLInputElement>("[data-arg]")];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });
        const args: unknown[] = [vals["recvClass"] || "fzk", vals["recvMethod"] || "Decode"];
        if (action === "startIncomingCapture") args.push(parseInt(vals["outputIndex"] || "2", 10));
        void runAction(action, args);
    });

    /**
     * Render the class label inside an entry with the right alias layering.
     * Priority: manual localStorage alias (★) > protobuf Descriptor name (auto) > preset alias (📚) > raw cls.
     */
    function renderClsEl(clsEl: HTMLElement, cls: string, protoName: string | undefined | null): void {
        const manualAlias = socketAliases[cls];                           // user ★
        const autoName    = protoName && protoName !== "?" ? protoName : null; // protobuf Descriptor
        const presetAlias = presetAliases[cls];                            // 📚 from preset

        // Preserve any existing dup-count span if re-rendering
        const existingCount = clsEl.querySelector(".dup-count")?.outerHTML ?? `<span class="dup-count" style="color:var(--ink-muted)"></span>`;

        let nameHtml: string;
        if (manualAlias) {
            nameHtml = `<span style="color:var(--ink-primary);cursor:pointer" class="cls-name">${manualAlias}★</span> <span style="color:var(--ink-disabled)">(${cls})</span>`;
        } else if (autoName) {
            nameHtml = `<span style="color:var(--ink-primary);cursor:pointer" class="cls-name">${autoName}</span> <span style="color:var(--ink-disabled)">(${cls})</span>`;
        } else if (presetAlias) {
            nameHtml = `<span style="color:var(--ok);cursor:pointer" class="cls-name" title="from preset">${presetAlias}📚</span> <span style="color:var(--ink-disabled)">(${cls})</span>`;
        } else {
            nameHtml = `<span style="cursor:pointer" class="cls-name">${cls || "?"}</span>`;
        }
        clsEl.innerHTML = nameHtml + existingCount;
    }

    function refreshEntryDisplay(el: HTMLElement): void {
        const cls = el.dataset.cls ?? "";
        const c = el.querySelector(".cls");
        if (!c) return;
        const protoName = el.dataset.autoName;
        renderClsEl(c as HTMLElement, cls, protoName);
    }

    function pushSocketEvent(p: SocketPayload): void {
        if (paused) {
            if (pauseBuffer.length < pauseBufferMax) pauseBuffer.push(p);
            pauseBtn.textContent = `▶ resume (${pauseBuffer.length} buffered)`;
            return;
        }

        // update stats
        totalEvents++;
        eventTimes.push(Date.now());
        const key = p.cls ?? "?";
        classCounts.set(key, (classCounts.get(key) ?? 0) + 1);

        // Merge into previous entry if: grouping enabled, same cls, no field body set
        // (If fields differ we treat as new to avoid hiding variation.)
        const hasFields = p.fields && Object.keys(p.fields).length > 0;
        if (groupCb.checked && lastEntry && lastEntry.cls === key && !hasFields) {
            lastEntry.count++;
            lastEntry.countEl.textContent = ` × ${lastEntry.count}`;
            lastEntry.tsEl.textContent = new Date(p.ts ?? Date.now()).toLocaleTimeString();
            if (autoscrollCb.checked) socketLogEl.scrollTop = socketLogEl.scrollHeight;
            return;
        }

        const entry = document.createElement("div");
        entry.className = "socket-entry " + (p.direction || "out");
        entry.dataset.cls = key;
        entry.dataset.autoName = p.name ?? "?";
        entry.style.cssText = `
            display:flex; align-items:flex-start; gap:var(--s-2);
            padding:4px var(--s-2); border-bottom:1px solid var(--border-soft);
            cursor:pointer;
        `;

        const ts = new Date(p.ts ?? Date.now()).toLocaleTimeString();
        const dirSymbol = p.direction === "in" ? "↓" : "↑";
        const dirColor = p.direction === "in" ? "var(--ok)" : "var(--accent)";

        const tsEl = document.createElement("span");
        tsEl.style.cssText = "color:var(--ink-disabled);min-width:70px;font-size:10.5px";
        tsEl.textContent = ts;

        const dirEl = document.createElement("span");
        dirEl.style.cssText = `color:${dirColor};min-width:14px;font-weight:700`;
        dirEl.textContent = dirSymbol;

        const clsEl = document.createElement("span");
        clsEl.className = "cls";
        clsEl.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

        renderClsEl(clsEl, key, p.name);

        const countEl = clsEl.querySelector(".dup-count") as HTMLElement;

        // detail pre (hidden by default, expanded on click)
        const previewEl = document.createElement("pre");
        previewEl.style.cssText = "display:none; font-size:10.5px; margin-top:4px; width:100%; color:var(--ink-muted)";
        const lines: string[] = [];
        if (p.fullName && p.fullName !== "?") lines.push(`[${p.fullName}]`);
        if (p.fields && Object.keys(p.fields).length) {
            for (const [k, val] of Object.entries(p.fields)) {
                const pretty = prettyFieldName(key, k);
                const displayK = pretty === k ? k : `${pretty} (${k.replace(/^<|>k__BackingField$/g, "")})`;
                lines.push(`  ${displayK} = ${String(val)}`);
            }
        } else {
            lines.push("(no field set)");
        }
        lines.push("");
        lines.push("click row to toggle details · click name to filter · right-click for alias");
        previewEl.textContent = lines.join("\n");

        // wrap cls + preview in a flex-col div
        const infoCol = document.createElement("div");
        infoCol.style.cssText = "flex:1;min-width:0;display:flex;flex-direction:column";
        infoCol.appendChild(clsEl);
        infoCol.appendChild(previewEl);

        entry.appendChild(tsEl);
        entry.appendChild(dirEl);
        entry.appendChild(infoCol);

        // Row click toggles detail (but not if clicking on the cls-name span)
        entry.addEventListener("click", (ev) => {
            if ((ev.target as HTMLElement).closest(".cls-name")) return;
            const shown = previewEl.style.display !== "none";
            previewEl.style.display = shown ? "none" : "";
        });

        // Click on cls name → toggle filter to this class
        clsEl.addEventListener("click", (ev) => {
            const target = (ev.target as HTMLElement).closest(".cls-name");
            if (!target) return;
            ev.stopPropagation();
            // If already filtered to this cls, clear; else set
            const newFilter = socketFilter === `^${key}$` ? "" : `^${key}$`;
            filterInput.value = newFilter;
            socketFilter = newFilter;
            applyFilter();
        });

        entry.addEventListener("contextmenu", (ev) => {
            ev.preventDefault();
            const current = socketAliases[key] || "";
            const next = prompt(`Alias for "${key}":`, current);
            if (next === null) return;
            if (next === "") { delete socketAliases[key]; }
            else { socketAliases[key] = next; }
            saveAliases();
            socketLogEl.querySelectorAll<HTMLElement>(`.socket-entry[data-cls="${key}"]`).forEach(refreshEntryDisplay);
        });

        if (socketFilter && !new RegExp(socketFilter, "i").test(key)) {
            entry.classList.add("filtered-out");
        }

        socketLogEl.appendChild(entry);
        lastEntry = { el: entry, cls: key, count: 1, countEl, tsEl };
        if (autoscrollCb.checked) socketLogEl.scrollTop = socketLogEl.scrollHeight;
    }

    // Load game-specific preset aliases (auto, 📚). Fire on mount and again
    // whenever the attached process changes.
    function refreshPresetAndEntries(): void {
        void loadPresetAliases().then(() => {
            socketLogEl.querySelectorAll<HTMLElement>(".socket-entry").forEach(refreshEntryDisplay);
            const count = Object.keys(presetAliases).length;
            if (count) logRpcLine(`[socket] preset aliases loaded (${count} entries)`);
        });
    }
    refreshPresetAndEntries();

    // Subscribe to socket events via WS. Clear previous mount's sub first
    // (tab cycling re-mounts this panel).
    if (mountWsUnsub) mountWsUnsub();
    mountWsUnsub = onWsEvent((ev) => {
        // Refresh preset aliases whenever the attach state flips
        if (ev.type === "attached" || ev.type === "detached") {
            refreshPresetAndEntries();
            return;
        }
        if (ev.type !== "message") return;
        const m = ev.message;
        if (m.type !== "send") return;
        const p = m["payload"] as Record<string, unknown> | null | undefined;
        if (!p || typeof p !== "object") return;
        if (p["type"] !== "socket") return;
        pushSocketEvent(p as unknown as SocketPayload);
    });
}
