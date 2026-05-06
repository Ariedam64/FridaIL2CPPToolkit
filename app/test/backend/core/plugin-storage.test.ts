import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { DiskPluginStorage } from "../../../backend/core/plugin-storage";

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-storage-"));
});

describe("DiskPluginStorage", () => {
    it("returns null for unknown keys when no file exists yet", () => {
        const s = new DiskPluginStorage(tmpRoot, "myplugin");
        expect(s.get("missing")).toBeNull();
    });

    it("stores and retrieves a value", () => {
        const s = new DiskPluginStorage(tmpRoot, "myplugin");
        s.set("foo", { bar: 1 });
        expect(s.get<{ bar: number }>("foo")).toEqual({ bar: 1 });
    });

    it("persists to disk and reloads from a new instance", () => {
        const s1 = new DiskPluginStorage(tmpRoot, "myplugin");
        s1.set("counter", 42);
        s1.set("list", ["a", "b"]);

        const filePath = path.join(tmpRoot, "plugins", "myplugin", "storage.json");
        expect(fs.existsSync(filePath)).toBe(true);

        const s2 = new DiskPluginStorage(tmpRoot, "myplugin");
        expect(s2.get<number>("counter")).toBe(42);
        expect(s2.get<string[]>("list")).toEqual(["a", "b"]);
    });

    it("delete removes a key and persists", () => {
        const s1 = new DiskPluginStorage(tmpRoot, "myplugin");
        s1.set("a", 1);
        s1.set("b", 2);
        s1.delete("a");
        expect(s1.get("a")).toBeNull();

        const s2 = new DiskPluginStorage(tmpRoot, "myplugin");
        expect(s2.get<number>("b")).toBe(2);
        expect(s2.get("a")).toBeNull();
    });

    it("list returns all keys", () => {
        const s = new DiskPluginStorage(tmpRoot, "myplugin");
        s.set("a", 1);
        s.set("b", 2);
        s.set("c", 3);
        expect(s.list().sort()).toEqual(["a", "b", "c"]);
    });

    it("isolates plugins from each other", () => {
        const a = new DiskPluginStorage(tmpRoot, "plugin-a");
        const b = new DiskPluginStorage(tmpRoot, "plugin-b");
        a.set("shared-key", "from-a");
        b.set("shared-key", "from-b");
        expect(a.get("shared-key")).toBe("from-a");
        expect(b.get("shared-key")).toBe("from-b");
    });

    it("sanitises pluginId so funky names cannot escape the plugins dir", () => {
        const s = new DiskPluginStorage(tmpRoot, "../escape");
        s.set("k", "v");
        // The traversal attempt MUST stay inside plugins/ — separators turn
        // into `_`, the dot is fine because it's inside a single component
        // (path.join doesn't resolve `..` mid-segment).
        const escapeFile = path.join(tmpRoot, "..", "escape", "storage.json");
        expect(fs.existsSync(escapeFile)).toBe(false);
        const plugins = fs.readdirSync(path.join(tmpRoot, "plugins"));
        expect(plugins).toHaveLength(1);
        expect(plugins[0]).not.toContain("/");
        expect(plugins[0]).not.toContain("\\");
    });

    it("recovers from a corrupt JSON file", () => {
        const dir = path.join(tmpRoot, "plugins", "myplugin");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "storage.json"), "{ this is not json", "utf-8");

        const s = new DiskPluginStorage(tmpRoot, "myplugin");
        expect(s.get("anything")).toBeNull();
        s.set("recovered", "yes");
        expect(s.get<string>("recovered")).toBe("yes");
    });
});
