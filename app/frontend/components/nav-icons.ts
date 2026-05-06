// app/frontend/components/nav-icons.ts

export type NavTab = "explorer" | "hooks" | "bookmarks" | "migrations";

export interface NavIconsConfig {
    onSelect(tab: NavTab): void;
    badges?: Partial<Record<NavTab, number>>;
}

export function renderNavIcons(host: HTMLElement, cfg: NavIconsConfig): { setActive(t: NavTab): void; setBadge(t: NavTab, n: number): void } {
    host.className = "nav-icons";
    host.innerHTML = `
        <div class="nav-icon" data-tab="explorer" title="Process Explorer">📦</div>
        <div class="nav-icon" data-tab="hooks" title="Hooks"><span class="badge-count" hidden></span>🪝</div>
        <div class="nav-icon" data-tab="bookmarks" title="Bookmarks">⭐</div>
        <div class="nav-icon" data-tab="migrations" title="Migrations">🔄</div>
    `;
    let activeTab: NavTab = "explorer";

    host.querySelectorAll<HTMLElement>(".nav-icon").forEach((el) => {
        el.addEventListener("click", () => {
            const t = el.dataset.tab as NavTab;
            cfg.onSelect(t);
            setActive(t);
        });
    });

    function setActive(t: NavTab): void {
        activeTab = t;
        host.querySelectorAll<HTMLElement>(".nav-icon").forEach((el) => {
            el.classList.toggle("active", el.dataset.tab === t);
        });
    }
    function setBadge(t: NavTab, n: number): void {
        const el = host.querySelector<HTMLElement>(`.nav-icon[data-tab="${t}"] .badge-count`);
        if (!el) return;
        if (n <= 0) { el.hidden = true; }
        else { el.hidden = false; el.textContent = String(n); }
    }
    setActive(activeTab);
    if (cfg.badges) {
        for (const [t, n] of Object.entries(cfg.badges)) setBadge(t as NavTab, n ?? 0);
    }
    return { setActive, setBadge };
}
