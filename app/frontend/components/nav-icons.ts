// app/frontend/components/nav-icons.ts
import { icons } from "../core/icons.js";
import { listPlugins } from "../core/plugin-host.js";

// NavTab is a string at runtime. Built-ins are listed here for clarity, but the
// runtime type accepts any string (plugin ids extend it dynamically).
export type NavTab =
    | "explorer" | "hooks" | "network" | "bookmarks" | "migrations" | "instances" | "scripts"
    | string;

export interface NavIconsConfig {
    onSelect(tab: NavTab): void;
    badges?: Partial<Record<string, number>>;
}

export function renderNavIcons(host: HTMLElement, cfg: NavIconsConfig): { setActive(t: NavTab): void; setBadge(t: NavTab, n: number): void } {
    host.className = "nav-icons";

    const builtin = `
        <div class="nav-icon" data-tab="explorer" title="Process Explorer">${icons.box(18)}</div>
        <div class="nav-icon" data-tab="hooks" title="Hooks"><span class="badge-count" hidden></span>${icons.hook(18)}</div>
        <div class="nav-icon" data-tab="network" title="Network">${icons.network(18)}</div>
        <div class="nav-icon" data-tab="bookmarks" title="Bookmarks">${icons.star(18)}</div>
        <div class="nav-icon" data-tab="migrations" title="Migrations">${icons.refresh(18)}</div>
        <div class="nav-icon" data-tab="instances" title="Instances">${icons.crosshair(18)}</div>
        <div class="nav-icon" data-tab="scripts" title="Scripts">${icons.play(18)}</div>
    `;

    const plugins = listPlugins();
    const pluginHtml = plugins.map((p) => {
        const iconFn = (icons as Record<string, ((s: number) => string) | undefined>)[p.navIcon];
        const svg = iconFn ? iconFn(18) : `<span style="font-size:14px">?</span>`;
        return `<div class="nav-icon plugin-icon" data-tab="${escapeAttr(p.id)}" title="${escapeAttr(p.displayName)}">${svg}</div>`;
    }).join("");

    const sep = pluginHtml ? `<div class="nav-sep" style="height:8px"></div>` : "";
    host.innerHTML = builtin + sep + pluginHtml;

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
        for (const [t, n] of Object.entries(cfg.badges)) setBadge(t, n ?? 0);
    }
    return { setActive, setBadge };
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
