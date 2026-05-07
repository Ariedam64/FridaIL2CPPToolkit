import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const VALID = (name: string) => `
    import { defineScript } from "@toolkit/scripts";
    export default defineScript({ name: "${name}", params: {}, run: async () => "${name}" });
`;

describe("ScriptLoader watch lifecycle", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-watch-"));
        loader = new ScriptLoader(dir);
        await loader.start();   // start chokidar
    });

    afterEach(async () => {
        await loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("loads files already present at start()", async () => {
        // First disposing the auto-started loader, then re-creating with pre-existing files.
        await loader.dispose();
        fs.writeFileSync(path.join(dir, "preExisting.ts"), VALID("preExisting"));
        loader = new ScriptLoader(dir);
        await loader.start();
        expect(loader.list().map((e) => e.id)).toContain("preExisting");
    });

    it("adds new files on add event", async () => {
        const events: string[] = [];
        loader.on("change", (e) => events.push(`change:${e.id}`));

        fs.writeFileSync(path.join(dir, "added.ts"), VALID("added"));
        await sleep(500);  // chokidar awaitWriteFinish(100ms) + fs + esbuild on Windows

        expect(loader.get("added")?.status).toBe("loaded");
        expect(events).toContain("change:added");
    });

    it("reloads on file change", async () => {
        fs.writeFileSync(path.join(dir, "v.ts"), VALID("v"));
        await sleep(500);
        const v1 = loader.get("v")?.loadedAt;

        await sleep(50);
        fs.writeFileSync(path.join(dir, "v.ts"), VALID("v")); // re-write
        await sleep(500);
        const v2 = loader.get("v")?.loadedAt;

        expect(v2).not.toBe(v1);
    });

    it("removes entry on unlink", async () => {
        fs.writeFileSync(path.join(dir, "gone.ts"), VALID("gone"));
        await sleep(500);
        expect(loader.get("gone")).not.toBeNull();

        fs.unlinkSync(path.join(dir, "gone.ts"));
        await sleep(500);
        expect(loader.get("gone")).toBeNull();
    });

    it("flags duplicate name across two files", async () => {
        fs.writeFileSync(path.join(dir, "first.ts"), VALID("dup"));
        await sleep(500);
        fs.writeFileSync(path.join(dir, "second.ts"), VALID("dup"));
        await sleep(500);

        const second = loader.get("second");
        expect(second?.status).toBe("validation-error");
        expect(second?.error).toMatch(/duplicate name 'dup'/);
    });

    it("ignores _types/ subdir and non-.ts files", async () => {
        fs.mkdirSync(path.join(dir, "_types"));
        fs.writeFileSync(path.join(dir, "_types", "junk.ts"), VALID("junk"));
        fs.writeFileSync(path.join(dir, "notes.txt"), "ignored");
        await sleep(500);

        expect(loader.get("junk")).toBeNull();
        expect(loader.get("notes")).toBeNull();
    });
});
