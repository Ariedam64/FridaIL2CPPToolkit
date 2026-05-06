// app/frontend/components/process-explorer.ts

import { api } from "../core/api.js";
import { subscribe } from "../core/ws.js";
import { icons } from "../core/icons.js";

interface AssemblyInfo { name: string; classes: number; }
interface NamespaceInfo { ns: string; classes: number; }
interface ClassEnriched {
    obfName: string; fullName: string; label: string | null;
    bookmarked: boolean; hasNote: boolean;
}

export interface ExplorerHandle {
    onClassSelect(cb: (fullName: string) => void): void;
}

export function renderProcessExplorer(host: HTMLElement): ExplorerHandle {
    host.className = "explorer-panel";
    host.innerHTML = `
        <div class="explorer-header">
            <h3>Process Explorer</h3>
            <span class="meta" id="exp-meta"></span>
        </div>
        <div class="filter-pill">
            <span style="color:var(--text-faint)">${icons.search()}</span>
            <input id="exp-filter" placeholder="Filter…" />
            <span class="kbd-mini">/</span>
        </div>
        <div class="tree" id="exp-tree"><div style="color:var(--text-faint);padding:1em">Loading…</div></div>
    `;
    const tree = host.querySelector<HTMLDivElement>("#exp-tree")!;
    const meta = host.querySelector<HTMLElement>("#exp-meta")!;
    const filter = host.querySelector<HTMLInputElement>("#exp-filter")!;
    const nsCache = new Map<string, NamespaceInfo[]>();
    const clsCache = new Map<string, ClassEnriched[]>();
    let onSelect: (fullName: string) => void = () => {};

    function escape(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

    function renderClassLabel(obfName: string, label: string | null, bookmarked: boolean, hasNote: boolean): string {
        let html = label
            ? `<span class="friendly">${escape(label)}</span><span class="obf-tag">[${escape(obfName)}]</span>`
            : escape(obfName);
        if (bookmarked) html += ` <span style="font-size:9px">${icons.star(10)}</span>`;
        if (hasNote) html += ` <span style="font-size:9px">${icons.note(10)}</span>`;
        return html;
    }

    async function loadAssemblies(): Promise<void> {
        try {
            const { result } = await api.rpc<AssemblyInfo[]>("listAssembliesInfo");
            tree.innerHTML = "";
            let total = 0;
            for (const a of result) {
                total += a.classes;
                tree.appendChild(renderAsmNode(a));
            }
            meta.textContent = `${(total / 1000).toFixed(1)}k cls`;
        } catch (e) {
            tree.innerHTML = `<div style="color:var(--danger);padding:1em">${escape(String(e))}</div>`;
        }
    }

    function renderAsmNode(a: AssemblyInfo): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node assembly";
        el.dataset.depth = "0";
        el.dataset.assembly = a.name;
        el.dataset.expanded = "false";
        el.innerHTML = `
            <span class="chevron">${icons.chevronRight(10)}</span>
            <span class="icon">${icons.box(12)}</span>
            <span class="label">${escape(a.name)}</span>
            <span class="count">${a.classes}</span>
        `;
        el.addEventListener("click", () => toggleAsm(el));
        return el;
    }

    async function toggleAsm(el: HTMLElement): Promise<void> {
        const asm = el.dataset.assembly!;
        if (el.dataset.expanded === "true") {
            // collapse: remove following non-assembly siblings
            let next = el.nextElementSibling;
            while (next && (next as HTMLElement).dataset.depth !== "0") {
                const r = next; next = next.nextElementSibling; r.remove();
            }
            el.dataset.expanded = "false";
            el.querySelector(".chevron")!.innerHTML = icons.chevronRight(10);
            return;
        }
        let nsList = nsCache.get(asm);
        if (!nsList) {
            const { result } = await api.rpc<NamespaceInfo[]>("listNamespaces", [asm]);
            nsList = result;
            nsCache.set(asm, nsList);
        }
        const frag = document.createDocumentFragment();
        for (const n of nsList) frag.appendChild(renderNsNode(asm, n));
        el.after(frag);
        el.dataset.expanded = "true";
        el.querySelector(".chevron")!.innerHTML = icons.chevronDown(10);
    }

    function renderNsNode(asm: string, n: NamespaceInfo): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node namespace";
        el.dataset.depth = "1";
        el.dataset.assembly = asm;
        el.dataset.ns = n.ns;
        el.dataset.expanded = "false";
        el.innerHTML = `
            <span class="chevron">${icons.chevronRight(10)}</span>
            <span class="icon">${icons.folder(12)}</span>
            <span class="label">${escape(n.ns || "(root)")}</span>
            <span class="count">${n.classes}</span>
        `;
        el.addEventListener("click", (ev) => { ev.stopPropagation(); toggleNs(el); });
        return el;
    }

    async function toggleNs(el: HTMLElement): Promise<void> {
        const asm = el.dataset.assembly!;
        const ns = el.dataset.ns!;
        if (el.dataset.expanded === "true") {
            let next = el.nextElementSibling;
            while (next && (next as HTMLElement).dataset.depth === "2") {
                const r = next; next = next.nextElementSibling; r.remove();
            }
            el.dataset.expanded = "false";
            el.querySelector(".chevron")!.innerHTML = icons.chevronRight(10);
            return;
        }
        const key = `${asm}::${ns}`;
        let list = clsCache.get(key);
        if (!list) {
            const { result } = await api.rpc<string[]>("listClassesIn", [asm, ns]);
            const profileLabels = (await api.getLabels()) as { classes: Record<string, { label: string }> };
            const annotations = await api.getAnnotations();
            const bookmarked = new Set<string>();
            const noted = new Set<string>();
            for (const k of annotations.bookmarks) {
                if (k.kind === "class") bookmarked.add(k.className);
            }
            for (const noteEntry of annotations.notes) {
                if (noteEntry.key.kind === "class") noted.add(noteEntry.key.className);
            }
            list = result.map((obfName) => ({
                obfName,
                fullName: ns ? `${ns}.${obfName}` : obfName,
                label: profileLabels.classes[obfName]?.label ?? null,
                bookmarked: bookmarked.has(obfName),
                hasNote: noted.has(obfName),
            }));
            clsCache.set(key, list);
        }
        const frag = document.createDocumentFragment();
        for (const c of list) frag.appendChild(renderClsNode(asm, ns, c));
        el.after(frag);
        el.dataset.expanded = "true";
        el.querySelector(".chevron")!.innerHTML = icons.chevronDown(10);
    }

    function renderClsNode(asm: string, ns: string, c: ClassEnriched): HTMLElement {
        const el = document.createElement("div");
        el.className = "tree-node cls";
        el.dataset.depth = "2";
        el.dataset.fullname = c.fullName;
        el.dataset.obf = c.obfName;
        const labelHtml = renderClassLabel(c.obfName, c.label, c.bookmarked, c.hasNote);
        el.innerHTML = `
            <span class="chevron">·</span>
            <span class="icon">${icons.layers(12)}</span>
            <span class="label">${labelHtml}</span>
        `;
        el.addEventListener("click", (ev) => { ev.stopPropagation(); selectClass(el, c.fullName); });
        return el;
    }

    function selectClass(el: HTMLElement, fullName: string): void {
        host.querySelectorAll<HTMLElement>(".tree-node.selected").forEach((n) => n.classList.remove("selected"));
        el.classList.add("selected");
        onSelect(fullName);
    }

    // ---- Search mode state ----
    let searchMode = false;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    let labelsCacheForSearch: any = null;
    let annotationsCacheForSearch: any = null;

    async function ensureLabelsCacheForSearch(): Promise<void> {
        if (!labelsCacheForSearch) {
            try { labelsCacheForSearch = await api.getLabels(); }
            catch { labelsCacheForSearch = { classes: {} }; }
        }
        if (!annotationsCacheForSearch) {
            try { annotationsCacheForSearch = await api.getAnnotations(); }
            catch { annotationsCacheForSearch = { bookmarks: [], notes: [] }; }
        }
    }

    function renderSearchResults(results: Array<{ shortName: string; fullName: string; assembly: string; ns: string }>): void {
        if (results.length === 0) {
            tree.innerHTML = `<div style="color:var(--text-faint);padding:1em">No matches.</div>`;
            return;
        }
        const labels = labelsCacheForSearch ?? { classes: {} };
        const annotations = annotationsCacheForSearch ?? { bookmarks: [], notes: [] };
        const bookmarked = new Set<string>(
            (annotations.bookmarks as any[]).filter((k: any) => k.kind === "class").map((k: any) => k.className as string)
        );
        const noted = new Set<string>(
            (annotations.notes as any[]).filter((n: any) => n.key.kind === "class").map((n: any) => n.key.className as string)
        );
        const frag = document.createDocumentFragment();
        for (const r of results) {
            const label = (labels.classes as any)[r.shortName]?.label ?? null;
            const enriched: ClassEnriched = {
                obfName: r.shortName,
                fullName: r.fullName,
                label,
                bookmarked: bookmarked.has(r.shortName),
                hasNote: noted.has(r.shortName),
            };
            const el = renderClsNode(r.assembly, r.ns, enriched);
            // Prepend namespace prefix in search mode for disambiguation
            const labelEl = el.querySelector<HTMLElement>(".label")!;
            const nsTag = r.ns ? `<span style="color:var(--text-faint);font-size:10px;margin-right:4px">${escape(r.ns)}.</span>` : "";
            labelEl.innerHTML = nsTag + labelEl.innerHTML;
            // Flat list — reset depth so indentation is uniform
            el.dataset.depth = "0";
            frag.appendChild(el);
        }
        tree.innerHTML = "";
        tree.appendChild(frag);
    }

    async function performSearch(query: string): Promise<void> {
        try {
            const { result } = await api.rpc<Array<{ shortName: string; fullName: string; assembly: string; ns: string }>>(
                "searchClasses", [query, 100]
            );
            renderSearchResults(result);
        } catch (e) {
            tree.innerHTML = `<div style="color:var(--danger);padding:1em">${escape(String(e))}</div>`;
        }
    }

    function onFilterChange(value: string): void {
        if (searchTimer) clearTimeout(searchTimer);
        if (value.length === 0) {
            searchMode = false;
            labelsCacheForSearch = null;
            annotationsCacheForSearch = null;
            void loadAssemblies();
            return;
        }
        if (value.length < 2) return; // Wait for ≥2 chars
        searchMode = true;
        searchTimer = setTimeout(async () => {
            await ensureLabelsCacheForSearch();
            await performSearch(value);
        }, 200);
    }

    filter.addEventListener("input", () => onFilterChange(filter.value));

    // Subscribe to label/annotation changes — refresh visible class nodes
    subscribe("label-change", (evt: any) => {
        if (evt.key?.kind === "class") {
            const className = evt.key.className;
            const newLabel = evt.newLabel;
            // Find cache entry to preserve bookmark/note state
            let cached: ClassEnriched | null = null;
            for (const list of clsCache.values()) {
                const found = list.find((c) => c.obfName === className);
                if (found) {
                    found.label = newLabel;  // Update cache too so collapse/re-expand stays in sync
                    cached = found;
                    break;
                }
            }
            tree.querySelectorAll<HTMLElement>(`.tree-node.cls[data-obf="${CSS.escape(className)}"]`).forEach((el) => {
                const labelEl = el.querySelector<HTMLElement>(".label")!;
                labelEl.innerHTML = renderClassLabel(className, newLabel, cached?.bookmarked ?? false, cached?.hasNote ?? false);
            });
        }
    });

    subscribe("annotation-change", (evt: any) => {
        if (evt.key?.kind !== "class") return;
        const className = evt.key.className;
        // Update cache
        let cached: ClassEnriched | null = null;
        for (const list of clsCache.values()) {
            const found = list.find((c) => c.obfName === className);
            if (found) {
                if (evt.kind === "bookmark") {
                    found.bookmarked = evt.action === "added";
                } else if (evt.kind === "note") {
                    found.hasNote = evt.action !== "removed";
                }
                cached = found;
                break;
            }
        }
        if (!cached) return;
        tree.querySelectorAll<HTMLElement>(`.tree-node.cls[data-obf="${CSS.escape(className)}"]`).forEach((el) => {
            const labelEl = el.querySelector<HTMLElement>(".label")!;
            labelEl.innerHTML = renderClassLabel(className, cached!.label, cached!.bookmarked, cached!.hasNote);
        });
    });

    subscribe("profile-attached", () => {
        nsCache.clear();
        clsCache.clear();
        labelsCacheForSearch = null;
        annotationsCacheForSearch = null;
        void loadAssemblies();
    });
    subscribe("profile-detached", () => {
        nsCache.clear();
        clsCache.clear();
        tree.innerHTML = `<div style="color:var(--text-faint);padding:1em">No process attached.</div>`;
    });

    // Add resize handle
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "explorer-resize-handle";
    host.appendChild(resizeHandle);

    // Restore persisted width
    const STORAGE_KEY = "frida.explorer.width";
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        const w = parseInt(stored, 10);
        if (Number.isFinite(w) && w >= 180 && w <= 600) {
            host.style.width = `${w}px`;
        }
    }

    // Drag-to-resize logic
    let dragStartX = 0;
    let dragStartWidth = 0;
    let dragging = false;

    function onPointerMove(ev: PointerEvent): void {
        if (!dragging) return;
        const dx = ev.clientX - dragStartX;
        let newW = dragStartWidth + dx;
        if (newW < 180) newW = 180;
        if (newW > 600) newW = 600;
        host.style.width = `${newW}px`;
    }
    function onPointerUp(): void {
        if (!dragging) return;
        dragging = false;
        resizeHandle.classList.remove("active");
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        // Persist
        const finalW = host.getBoundingClientRect().width;
        localStorage.setItem(STORAGE_KEY, String(Math.round(finalW)));
    }

    resizeHandle.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        dragging = true;
        dragStartX = ev.clientX;
        dragStartWidth = host.getBoundingClientRect().width;
        resizeHandle.classList.add("active");
        document.body.style.userSelect = "none";
        document.body.style.cursor = "col-resize";
        window.addEventListener("pointermove", onPointerMove);
        window.addEventListener("pointerup", onPointerUp);
    });

    void loadAssemblies();

    return {
        onClassSelect(cb) { onSelect = cb; },
    };
}
