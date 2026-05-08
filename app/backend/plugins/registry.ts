import type { Express } from "express";
import type { Session } from "../session";
import * as dofusRoutes from "../../plugins/dofus/routes";

/**
 * Backend mount function for a plugin. Receives the Express app and the
 * shared session. The plugin should mount routes under /api/<plugin.id>/...
 */
export interface PluginBackend {
    id: string;
    mount: (app: Express, deps: PluginBackendDeps) => void;
}

export interface PluginBackendDeps {
    session: Session;
}

/**
 * Hand-maintained list of plugins that have backend routes. Add a new entry
 * here when a plugin needs server-side functionality. Plugins without backend
 * routes (frontend-only) do not need to appear in this list.
 */
export const PLUGIN_BACKENDS: PluginBackend[] = [
    { id: "dofus", mount: dofusRoutes.mount },
];

/**
 * Mount every plugin backend, isolating failures so one broken plugin can't
 * take down the rest of the server. The `plugins` parameter defaults to
 * `PLUGIN_BACKENDS` for production; tests can pass a custom list.
 */
export function mountAllPluginBackends(
    app: Express,
    deps: PluginBackendDeps,
    plugins: PluginBackend[] = PLUGIN_BACKENDS,
): void {
    for (const plugin of plugins) {
        try {
            plugin.mount(app, deps);
            console.log(`[plugins] mounted backend for '${plugin.id}'`);
        } catch (err) {
            console.error(`[plugins] failed to mount backend for '${plugin.id}':`, err);
        }
    }
}
