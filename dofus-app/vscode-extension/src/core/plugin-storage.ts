// Disk-backed storage for plugins. Lives at
// `<profile>/plugins/<pluginId>/storage.json`.
//
// Kept vscode-free so it can be unit-tested with vitest.

import * as fs from "fs";
import * as path from "path";

import type { PluginStorage } from "./api"; // type-only — breaks no runtime cycle

export class DiskPluginStorage implements PluginStorage {
    private cache: Map<string, unknown> | null = null;
    private readonly filePath: string;

    constructor(profileRoot: string, pluginId: string) {
        const safePluginId = pluginId.replace(/[^A-Za-z0-9_.-]/g, "_");
        this.filePath = path.join(profileRoot, "plugins", safePluginId, "storage.json");
    }

    get<T>(key: string): T | null {
        const data = this.load();
        return (data.get(key) as T) ?? null;
    }

    set<T>(key: string, value: T): void {
        const data = this.load();
        data.set(key, value);
        this.persist();
    }

    delete(key: string): void {
        const data = this.load();
        if (!data.delete(key)) return;
        this.persist();
    }

    list(): string[] {
        return Array.from(this.load().keys());
    }

    private load(): Map<string, unknown> {
        if (this.cache) return this.cache;
        this.cache = new Map();
        if (!fs.existsSync(this.filePath)) return this.cache;
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const obj = JSON.parse(raw) as Record<string, unknown>;
            for (const [k, v] of Object.entries(obj)) {
                this.cache.set(k, v);
            }
        } catch {
            // Corrupt JSON — start fresh; the next persist() overwrites it.
        }
        return this.cache;
    }

    private persist(): void {
        if (!this.cache) return;
        const obj: Record<string, unknown> = {};
        for (const [k, v] of this.cache) obj[k] = v;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
        fs.renameSync(tmp, this.filePath);
    }
}
