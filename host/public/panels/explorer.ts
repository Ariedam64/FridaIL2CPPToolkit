// Explorer panel — class tree browser by assembly or by inheritance.
import { rpcCall } from "../lib/rpc.js";

interface AsmInfo    { name: string; classes: number; }
interface NsInfo     { ns: string; classes: number; }

function dumpFromTree(fullName: string): void {
    // Fill every class-name input in the DOM
    document.querySelectorAll<HTMLInputElement>('[data-arg="className"],[data-arg="name"]')
        .forEach(inp => { inp.value = fullName; });
    // Switch to search tab and trigger a dump
    const searchTab = document.querySelector<HTMLElement>('.tabs[data-tabs="main"] .tab[data-tab="search"]');
    if (searchTab && !searchTab.classList.contains("active")) searchTab.click();
    document.dispatchEvent(new CustomEvent("dump-class", { detail: { name: fullName, action: "dumpClass" } }));
}

interface NodeOpts {
    label: string;
    meta?: string | number | null;
    klass?: string;
    expandable: boolean;
    onExpand?: () => Promise<HTMLUListElement>;
    onClick?: (ev: MouseEvent) => void;
}

function makeNode(opts: NodeOpts): HTMLLIElement {
    const { label, meta, klass, expandable, onExpand, onClick } = opts;
    const li = document.createElement("li");
    const node = document.createElement("div");
    node.className = "node" + (klass ? ` ${klass}` : "");
    node.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;border-radius:var(--r-sm)";
    node.style.userSelect = "none";

    const caret = document.createElement("span");
    caret.style.cssText = "width:12px;text-align:center;color:var(--accent);font-size:10px;flex-shrink:0";
    caret.textContent = expandable ? "▸" : " ";

    const lbl = document.createElement("span");
    lbl.className = "label";
    lbl.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px";
    lbl.textContent = label;
    (lbl as HTMLElement & { dataset: DOMStringMap }).dataset["label"] = label.toLowerCase();

    node.appendChild(caret);
    node.appendChild(lbl);

    if (meta != null) {
        const metaEl = document.createElement("span");
        metaEl.className = "tag";
        metaEl.textContent = String(meta);
        node.appendChild(metaEl);
    }

    li.appendChild(node);

    let loaded = false;
    let childrenEl: HTMLUListElement | null = null;

    node.addEventListener("click", async (ev) => {
        ev.stopPropagation();

        if (!expandable && onClick) { onClick(ev); return; }

        if (expandable) {
            const isOpen = node.classList.contains("open");
            if (isOpen) {
                node.classList.remove("open");
                caret.textContent = "▸";
                if (childrenEl) childrenEl.style.display = "none";
                return;
            }
            node.classList.add("open");
            caret.textContent = "▾";

            if (!loaded) {
                loaded = true;
                const metaEl = node.querySelector(".tag");
                const originalMeta = metaEl ? metaEl.textContent : "";
                if (metaEl) metaEl.textContent = "…";
                try {
                    childrenEl = onExpand ? await onExpand() : null;
                    if (childrenEl) li.appendChild(childrenEl);
                    if (metaEl) metaEl.textContent = originalMeta ?? "";
                } catch (e) {
                    node.classList.remove("open");
                    caret.textContent = "▸";
                    if (metaEl) metaEl.textContent = `err: ${String(e)}`;
                    loaded = false;
                }
            } else if (childrenEl) {
                childrenEl.style.display = "";
            }

            if (expandable && onClick && ev.shiftKey) onClick(ev);
        }
    });

    return li;
}

function childList(): HTMLUListElement {
    const ul = document.createElement("ul");
    ul.className = "children";
    ul.style.cssText = "list-style:none;padding:0;margin:0 0 0 18px;border-left:1px solid var(--border-soft)";
    return ul;
}

async function buildInheritanceNode(baseName: string): Promise<HTMLLIElement> {
    return makeNode({
        label: baseName,
        klass: "cls",
        expandable: true,
        onClick: () => dumpFromTree(baseName),
        onExpand: async () => {
            const ul = childList();
            const subs = await rpcCall<string[]>("listSubclasses", [baseName, 500]);
            if (!subs.length) {
                const empty = document.createElement("li");
                empty.innerHTML = `<div style="display:flex;align-items:center;gap:6px;padding:3px 4px">
                    <span style="width:12px"></span>
                    <span style="color:var(--ink-disabled);font-style:italic;font-size:11.5px">(no direct subclass)</span>
                </div>`;
                ul.appendChild(empty);
                return ul;
            }
            for (const sub of subs) {
                ul.appendChild(await buildInheritanceNode(sub));
            }
            return ul;
        },
    });
}

function applyTreeFilter(treeEl: HTMLElement, q: string): void {
    const lower = q.toLowerCase();
    treeEl.querySelectorAll<HTMLLIElement>("li").forEach(li => {
        if (!lower) { li.classList.remove("filtered-out"); return; }
        const lblEl = li.querySelector<HTMLElement>(":scope > .node > .label");
        const match = !!(lblEl?.dataset["label"]?.includes(lower));
        const hasDescendant = !!li.querySelector(`.label[data-label*="${CSS.escape(lower)}"]`);
        li.classList.toggle("filtered-out", !match && !hasDescendant);
    });
}

export async function loadExplorerTree(
    treeEl: HTMLElement,
    mode: string,
    inheritanceRoot: string,
): Promise<void> {
    treeEl.textContent = "loading…";
    try {
        const rootUl = document.createElement("ul");
        rootUl.style.cssText = "list-style:none;padding:0;margin:0";

        if (mode === "assembly") {
            const asms = await rpcCall<AsmInfo[]>("listAssembliesInfo", []);
            for (const a of asms) {
                rootUl.appendChild(makeNode({
                    label: a.name,
                    meta: a.classes,
                    klass: "asm",
                    expandable: true,
                    onExpand: async () => {
                        const ul = childList();
                        const namespaces = await rpcCall<NsInfo[]>("listNamespaces", [a.name]);
                        for (const nsInfo of namespaces) {
                            ul.appendChild(makeNode({
                                label: nsInfo.ns,
                                meta: nsInfo.classes,
                                klass: "ns",
                                expandable: true,
                                onExpand: async () => {
                                    const ul2 = childList();
                                    const classes = await rpcCall<string[]>("listClassesIn", [a.name, nsInfo.ns]);
                                    for (const cls of classes) {
                                        const fullName = nsInfo.ns === "(root)" ? cls : `${nsInfo.ns}.${cls}`;
                                        ul2.appendChild(makeNode({
                                            label: cls,
                                            klass: "cls",
                                            expandable: false,
                                            onClick: () => dumpFromTree(fullName),
                                        }));
                                    }
                                    return ul2;
                                },
                            }));
                        }
                        return ul;
                    },
                }));
            }
        } else if (mode === "inheritance") {
            const root = inheritanceRoot || "UnityEngine.MonoBehaviour";
            rootUl.appendChild(await buildInheritanceNode(root));
        }

        treeEl.innerHTML = "";
        treeEl.appendChild(rootUl);
    } catch (e) {
        treeEl.textContent = "error: " + String(e);
    }
}

export function renderExplorer(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-2); padding:var(--s-3); height:100%; overflow:hidden">
        <div style="display:flex; gap:var(--s-2); align-items:center; flex-shrink:0">
          <select class="input" id="exp-mode" style="flex:1">
            <option value="assembly">by assembly</option>
            <option value="inheritance">by inheritance</option>
          </select>
          <button class="btn" id="exp-reload">↻</button>
        </div>
        <div id="exp-inherit-row" style="display:none; gap:var(--s-2); flex-shrink:0">
          <input class="input" id="exp-inherit-root" placeholder="UnityEngine.MonoBehaviour" style="flex:1">
          <button class="btn" id="exp-inherit-go">go</button>
        </div>
        <input class="input" id="exp-filter" placeholder="filter classes…" style="flex-shrink:0">
        <div id="exp-tree" style="flex:1; overflow:auto; font-family:var(--font-mono); font-size:11.5px"></div>
      </div>
    `;

    const modeEl     = container.querySelector("#exp-mode")         as HTMLSelectElement;
    const reloadBtn  = container.querySelector("#exp-reload")        as HTMLButtonElement;
    const inheritRow = container.querySelector("#exp-inherit-row")   as HTMLElement;
    const inheritRoot= container.querySelector("#exp-inherit-root")  as HTMLInputElement;
    const goBtn      = container.querySelector("#exp-inherit-go")    as HTMLButtonElement;
    const filterEl   = container.querySelector("#exp-filter")        as HTMLInputElement;
    const treeEl     = container.querySelector("#exp-tree")          as HTMLElement;

    function load(): void {
        inheritRow.style.display = modeEl.value === "inheritance" ? "flex" : "none";
        void loadExplorerTree(treeEl, modeEl.value, inheritRoot.value.trim());
    }

    let filterTimer: ReturnType<typeof setTimeout> | null = null;
    filterEl.addEventListener("input", () => {
        if (filterTimer !== null) clearTimeout(filterTimer);
        filterTimer = setTimeout(() => applyTreeFilter(treeEl, filterEl.value.trim()), 150);
    });

    modeEl.addEventListener("change", load);
    reloadBtn.addEventListener("click", load);
    goBtn.addEventListener("click", load);

    load();
}
