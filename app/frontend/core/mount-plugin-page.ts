import { renderPluginNotAttached } from "../components/plugin-not-attached";
import type { GamePlugin, PluginPageContext } from "./plugin-types";

export interface MountPluginPageOpts {
    profile: { gameName: string; buildId: string } | null;
    currentSubTab: string | null;
    setSubTab: (key: string) => void;
    onAttachClick: () => void;
}

/**
 * Mounts a plugin's root page into the host element, or renders a "not attached"
 * notice when the active profile doesn't match the plugin's targetted gameName.
 *
 * Pure helper — no global state. main.ts is responsible for passing in the
 * current profile + handlers.
 */
export async function mountPluginPage(
    host: HTMLElement,
    plugin: GamePlugin,
    opts: MountPluginPageOpts,
): Promise<void> {
    if (!opts.profile || opts.profile.gameName !== plugin.gameName) {
        renderPluginNotAttached(host, {
            plugin,
            currentGameName: opts.profile?.gameName ?? null,
            onAttachClick: opts.onAttachClick,
        });
        return;
    }

    let pageModule;
    try {
        const m = await plugin.rootPage();
        pageModule = m.default;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        host.innerHTML = `
            <div style="margin:auto;padding:32px;max-width:520px;text-align:center;color:var(--text-faint)">
                <h2 style="color:#f87171">Failed to load ${escapeHtml(plugin.displayName)} plugin</h2>
                <pre style="white-space:pre-wrap;text-align:left">${escapeHtml(msg)}</pre>
            </div>
        `;
        return;
    }

    const ctx: PluginPageContext = {
        profile: opts.profile,
        currentSubTab: opts.currentSubTab,
        setSubTab: opts.setSubTab,
    };
    pageModule.mount(host, ctx);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
