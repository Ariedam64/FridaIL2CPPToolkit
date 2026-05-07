import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";

describe("ScriptLoader.loadFile", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-test-"));
        loader = new ScriptLoader(dir);
    });

    afterEach(() => {
        loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeScript(name: string, src: string): string {
        const p = path.join(dir, `${name}.ts`);
        fs.writeFileSync(p, src);
        return p;
    }

    it("loads a valid defineScript file → status 'loaded'", async () => {
        writeScript("hello", `
            import { defineScript } from "@toolkit/scripts";
            export default defineScript({
                name: "hello",
                params: { who: { type: "string", required: true } },
                run: async ({ who }) => "hi " + who,
            });
        `);
        const entry = await loader.loadFile(path.join(dir, "hello.ts"));
        expect(entry.status).toBe("loaded");
        expect(entry.definition?.name).toBe("hello");
        expect(entry.id).toBe("hello");
    });

    it("returns 'compile-error' on syntax error", async () => {
        writeScript("broken", `export default defineScript({{{{`);
        const entry = await loader.loadFile(path.join(dir, "broken.ts"));
        expect(entry.status).toBe("compile-error");
        expect(entry.error).toBeTruthy();
    });

    it("returns 'validation-error' when run is not async function", async () => {
        writeScript("badrun", `
            import { defineScript } from "@toolkit/scripts";
            export default { name: "badrun", params: {}, run: 42 };
        `);
        const entry = await loader.loadFile(path.join(dir, "badrun.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/run.*function/);
    });

    it("returns 'validation-error' when name is empty", async () => {
        writeScript("badname", `
            import { defineScript } from "@toolkit/scripts";
            export default defineScript({ name: "", params: {}, run: async () => null });
        `);
        const entry = await loader.loadFile(path.join(dir, "badname.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/name/);
    });

    it("blocks require() calls (not adversarial sandbox, defensive)", async () => {
        writeScript("evil", `
            const fs = require("fs");
            export default { name: "evil", params: {}, run: async () => null };
        `);
        const entry = await loader.loadFile(path.join(dir, "evil.ts"));
        expect(entry.status).toBe("validation-error");
        expect(entry.error).toMatch(/require/);
    });
});
