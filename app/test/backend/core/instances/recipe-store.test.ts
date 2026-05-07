import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RecipeStore } from "../../../../backend/core/instances/recipe-store";
import { DiskPluginStorage } from "../../../../backend/core/plugin-storage";
import type { RecipeStep } from "../../../../backend/core/instances/types";

const sampleSteps: RecipeStep[] = [
    { op: "captureViaGC", className: "PlayerCharacter", index: 0, asKey: "player" },
    { op: "captureFieldValue", ownerKey: "player", fieldName: "inventory", asKey: "inv" },
];

async function makeStore(): Promise<{ store: RecipeStore; tmpDir: string }> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-store-"));
    const storage = new DiskPluginStorage(tmpDir, "instances");
    const store = new RecipeStore(storage);
    if (typeof (store as any).init === "function") await (store as any).init();
    return { store, tmpDir };
}

describe("RecipeStore", () => {
    it("add creates a recipe and persists to disk", async () => {
        const { store, tmpDir } = await makeStore();
        const r = store.add("player+inv", sampleSteps);
        expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(r.name).toBe("player+inv");
        expect(r.steps).toEqual(sampleSteps);
        await store.flush();

        // DiskPluginStorage persists to <profileRoot>/plugins/<pluginId>/storage.json
        // using key-value format: { "recipe-store": { schemaVersion: 1, recipes: [...] } }
        const file = path.join(tmpDir, "plugins", "instances", "storage.json");
        const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
        const payload = raw["recipe-store"];
        expect(payload.schemaVersion).toBe(1);
        expect(payload.recipes).toHaveLength(1);
        expect(payload.recipes[0].name).toBe("player+inv");
    });

    it("list returns all recipes", async () => {
        const { store } = await makeStore();
        store.add("a", sampleSteps);
        store.add("b", sampleSteps);
        expect(store.list()).toHaveLength(2);
    });

    it("get returns a single recipe by id", async () => {
        const { store } = await makeStore();
        const r = store.add("a", sampleSteps);
        expect(store.get(r.id)?.name).toBe("a");
        expect(store.get("missing-id")).toBeNull();
    });

    it("update mutates fields and updates updatedAt", async () => {
        const { store } = await makeStore();
        const r = store.add("a", sampleSteps);
        const oldUpdatedAt = r.updatedAt;
        await new Promise((res) => setTimeout(res, 5));
        store.update(r.id, { name: "renamed", lastReplayStatus: "ok" });
        const after = store.get(r.id)!;
        expect(after.name).toBe("renamed");
        expect(after.lastReplayStatus).toBe("ok");
        expect(after.updatedAt).not.toBe(oldUpdatedAt);
    });

    it("delete removes a recipe", async () => {
        const { store } = await makeStore();
        const r = store.add("a", sampleSteps);
        store.delete(r.id);
        expect(store.get(r.id)).toBeNull();
    });

    it("reload from disk restores state", async () => {
        const { store: s1, tmpDir } = await makeStore();
        s1.add("persisted", sampleSteps);
        await s1.flush();

        const storage2 = new DiskPluginStorage(tmpDir, "instances");
        const s2 = new RecipeStore(storage2);
        if (typeof (s2 as any).init === "function") await (s2 as any).init();
        const list = s2.list();
        expect(list).toHaveLength(1);
        expect(list[0].name).toBe("persisted");
    });

    it("onChange emits on add/update/delete", async () => {
        const { store } = await makeStore();
        let count = 0;
        store.onChange(() => { count++; });
        const r = store.add("a", sampleSteps);
        store.update(r.id, { name: "b" });
        store.delete(r.id);
        expect(count).toBe(3);
    });

    it("corrupt JSON is recovered cleanly (empty store)", async () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-store-corrupt-"));
        const dir = path.join(tmpDir, "plugins", "instances");
        fs.mkdirSync(dir, { recursive: true });
        // Write a corrupt storage.json file that DiskPluginStorage will fail to parse
        fs.writeFileSync(path.join(dir, "storage.json"), "not valid json {");
        const storage = new DiskPluginStorage(tmpDir, "instances");
        const store = new RecipeStore(storage);
        if (typeof (store as any).init === "function") await (store as any).init();
        expect(store.list()).toHaveLength(0);
    });
});
