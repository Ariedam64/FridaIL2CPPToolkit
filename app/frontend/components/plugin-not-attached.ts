import type { GamePlugin } from "../core/plugin-types";

export interface PluginNotAttachedOpts {
    plugin: GamePlugin;
    currentGameName: string | null;
    onAttachClick: () => void;
}

export function renderPluginNotAttached(host: HTMLElement, opts: PluginNotAttachedOpts): void {
    const { plugin, currentGameName, onAttachClick } = opts;
    const detail = currentGameName
        ? `Currently attached to <code>${escapeHtml(currentGameName)}</code>.`
        : `No process attached.`;

    host.innerHTML = `
        <div style="margin:auto;padding:32px;max-width:520px;text-align:center">
            <h2 style="margin-top:0">${escapeHtml(plugin.displayName)} plugin</h2>
            <p>This plugin requires attaching to <code>${escapeHtml(plugin.gameName)}</code>.</p>
            <p style="color:var(--text-faint)">${detail}</p>
            <button data-testid="attach-btn" class="btn primary" style="margin-top:16px">Attach to a process…</button>
        </div>
    `;

    host.querySelector<HTMLButtonElement>("[data-testid='attach-btn']")!
        .addEventListener("click", () => onAttachClick());
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!
    ));
}
