import { randomUUID } from "node:crypto";
import type { DiskPluginStorage } from "../plugin-storage";
import type { Recipe, RecipeStep, RecipeStoreSchemaV1 } from "./types";

const STORAGE_KEY = "recipe-store";
const SCHEMA_VERSION = 1;
type Listener = () => void;

export class RecipeStore {
    private recipes: Recipe[] = [];
    private listeners: Listener[] = [];

    constructor(private readonly storage: DiskPluginStorage) {
        this.loadFromStorage();
    }

    list(): Recipe[] { return this.recipes.slice(); }

    get(id: string): Recipe | null {
        return this.recipes.find((r) => r.id === id) ?? null;
    }

    add(name: string, steps: RecipeStep[], description?: string): Recipe {
        const now = new Date().toISOString();
        const recipe: Recipe = {
            id: randomUUID(), name, description, steps,
            createdAt: now, updatedAt: now,
        };
        this.recipes.push(recipe);
        this.persist();
        this.emit();
        return recipe;
    }

    update(
        id: string,
        patch: Partial<Pick<Recipe, "name" | "description" | "steps" | "lastReplayedAt" | "lastReplayStatus">>,
    ): void {
        const r = this.recipes.find((x) => x.id === id);
        if (!r) return;
        Object.assign(r, patch);
        r.updatedAt = new Date().toISOString();
        this.persist();
        this.emit();
    }

    delete(id: string): void {
        const i = this.recipes.findIndex((r) => r.id === id);
        if (i < 0) return;
        this.recipes.splice(i, 1);
        this.persist();
        this.emit();
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const idx = this.listeners.indexOf(listener);
            if (idx >= 0) this.listeners.splice(idx, 1);
        };
    }

    /** Explicit flush — awaitable for tests. Sync DiskPluginStorage persists
     *  synchronously inside `persist()`, so this is always already settled. */
    async flush(): Promise<void> {
        // DiskPluginStorage.set() is synchronous — nothing more to do.
    }

    private persist(): void {
        const data: RecipeStoreSchemaV1 = { schemaVersion: SCHEMA_VERSION, recipes: this.recipes };
        this.storage.set(STORAGE_KEY, data);
    }

    private loadFromStorage(): void {
        try {
            const raw = this.storage.get<RecipeStoreSchemaV1>(STORAGE_KEY);
            if (!raw) return;
            if (raw.schemaVersion === SCHEMA_VERSION) {
                this.recipes = raw.recipes ?? [];
            }
        } catch { /* corrupt or missing — start fresh */ }
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }
}
