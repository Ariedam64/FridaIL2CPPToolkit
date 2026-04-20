// Entry point. Wires tab switching + will mount panels later.
function $(sel: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`element not found: ${sel}`);
    return el as HTMLElement;
}

function wireTabs(groupName: string, contentEl: HTMLElement): void {
    const tabsEl = document.querySelector(`[data-tabs="${groupName}"]`) as HTMLElement | null;
    if (!tabsEl) return;
    tabsEl.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
        if (!btn) return;
        const name = btn.dataset.tab;
        if (!name) return;
        for (const t of tabsEl.querySelectorAll(".tab")) t.classList.remove("active");
        btn.classList.add("active");
        contentEl.dataset.active = name;
        // Emit an event panels will subscribe to
        document.dispatchEvent(new CustomEvent("tab-change", { detail: { group: groupName, name } }));
    });
}

wireTabs("sidebar", $("#sidebar-content"));
wireTabs("main", $("#main-content"));

console.log("[main] bootstrapped");
