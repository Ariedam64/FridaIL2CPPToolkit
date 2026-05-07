import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ScriptLoader } from "../../../../backend/core/scripts/script-loader";
import { ScriptRunner } from "../../../../backend/core/scripts/script-runner";
import { buildToolkit } from "../../../../backend/core/scripts/toolkit-api";

describe("ScriptRunner — source-map remapping", () => {
    let dir: string;
    let loader: ScriptLoader;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-sm-"));
        loader = new ScriptLoader(dir);
    });

    afterEach(async () => {
        await loader.dispose();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("error stack points to user .ts line, not JS line", async () => {
        const filePath = path.join(dir, "boom.ts");
        // 5 leading lines + throw on line 6
        fs.writeFileSync(filePath, [
            "import { defineScript } from '@toolkit/scripts';",
            "export default defineScript({",
            "    name: 'boom', params: {},",
            "    run: async () => {",
            "        const x = 1;",
            "        throw new Error('explode');",
            "    },",
            "});",
        ].join("\n"));

        await loader.loadFile(filePath);
        const runner = new ScriptRunner(
            loader,
            { instanceRegistry: null, hookStore: null, frameStore: null, agentCall: async () => null, resolveLabel: (l) => l },
            buildToolkit,
        );
        const results: unknown[] = [];
        runner.on("result", (r) => results.push(r));
        const { runId } = await runner.start("boom", {});
        await runner.waitFor(runId);

        const r = results[0] as { status: string; error: { message: string; stack?: string } };
        expect(r.status).toBe("error");
        expect(r.error.stack).toMatch(/boom\.ts:6/);  // line of `throw`
    });
});
