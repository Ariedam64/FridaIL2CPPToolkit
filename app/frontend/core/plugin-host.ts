import { BUILTIN_TABS, type GamePlugin } from "./plugin-types";

/**
 * Build a registry from a glob result. Pure factory — testable without vite.
 * Order of iteration follows the input modules object (insertion order),
 * so the "first wins" rule for duplicates is deterministic.
 */
export function createRegistry(
    modules: Record<string, { default: GamePlugin }>,
): Map<string, GamePlugin> {
    const map = new Map<string, GamePlugin>();
    for (const m of Object.values(modules)) {
        const p = m.default;
        if (BUILTIN_TABS.has(p.id)) {
            console.warn(`[plugin-host] built-in tab collision: plugin id '${p.id}' is reserved, skipping`);
            continue;
        }
        if (map.has(p.id)) {
            console.warn(`[plugin-host] duplicate plugin id '${p.id}', skipping`);
            continue;
        }
        map.set(p.id, p);
    }
    return map;
}

// Vite eager glob: all manifests are evaluated at build time.
const modules = import.meta.glob<{ default: GamePlugin }>(
    "../../plugins/*/manifest.ts",
    { eager: true },
);

const PLUGINS = createRegistry(modules);

export function listPlugins(): GamePlugin[] {
    return Array.from(PLUGINS.values());
}

export function getPlugin(id: string): GamePlugin | null {
    return PLUGINS.get(id) ?? null;
}
