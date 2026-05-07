// Game Plugin System — shared types.
// Imported by plugin-host, mount-plugin-page, nav-icons, every plugin manifest.

export interface GamePlugin {
    /** Unique slug, used as the nav tab id and route hash, e.g. "dofus". */
    id: string;
    /** Human-friendly name shown in nav title and notice messages. */
    displayName: string;
    /** Matches profile.manifest.gameName. The plugin page is only mounted when these match. */
    gameName: string;
    /** Key from icons.ts catalog (e.g. "crown", "box"). Resolved at render time. */
    navIcon: string;
    /** Lazy-loaded root page. Vite code-splits it into a separate chunk. */
    rootPage: () => Promise<{ default: PluginPageModule }>;
}

export interface PluginPageModule {
    /** Mount the plugin's root page into `host`. The plugin owns the layout. */
    mount(host: HTMLElement, ctx: PluginPageContext): void;
}

export interface PluginPageContext {
    /** Currently attached profile (gameName already verified to match plugin.gameName). */
    profile: { gameName: string; buildId: string };
    /** Sub-tab key parsed from the URL hash, e.g. "map" if hash is "#/dofus?sub=map". */
    currentSubTab: string | null;
    /** Updates location.hash to "#/<plugin.id>?sub=<key>", triggering a re-mount. */
    setSubTab(key: string): void;
}

/** Identity factory — typed for inference; runtime is pass-through. */
export function defineGamePlugin(p: GamePlugin): GamePlugin {
    return p;
}

/**
 * Tabs reserved by the toolkit core. A plugin with one of these ids is rejected
 * by the host with a console warning.
 */
export const BUILTIN_TABS: ReadonlySet<string> = new Set([
    "explorer", "hooks", "network", "bookmarks", "migrations", "instances", "scripts",
]);
