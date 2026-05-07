import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { emitScriptsTypes } from "../../../../backend/core/scripts/types-emitter";

describe("emitScriptsTypes", () => {
    let dir: string;

    beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "scripts-emit-")); });
    afterEach(()  => { fs.rmSync(dir, { recursive: true, force: true }); });

    it("creates _types/toolkit.d.ts with required exports", () => {
        emitScriptsTypes(dir);
        const dts = fs.readFileSync(path.join(dir, "_types", "toolkit.d.ts"), "utf8");
        expect(dts).toMatch(/export\s+function\s+defineScript/);
        expect(dts).toMatch(/export\s+interface\s+Toolkit/);
        expect(dts).toMatch(/export\s+type\s+ParamSpec/);
    });

    it("creates tsconfig.json with paths mapping for @toolkit/scripts", () => {
        emitScriptsTypes(dir);
        const tsconfig = JSON.parse(fs.readFileSync(path.join(dir, "tsconfig.json"), "utf8"));
        expect(tsconfig.compilerOptions.paths["@toolkit/scripts"][0]).toMatch(/_types\/toolkit\.d\.ts/);
        expect(tsconfig.exclude).toContain("_types/**");
    });

    it("is idempotent (overwrites without error)", () => {
        emitScriptsTypes(dir);
        emitScriptsTypes(dir);
        expect(fs.existsSync(path.join(dir, "_types", "toolkit.d.ts"))).toBe(true);
    });

    it("creates dirs if missing", () => {
        const sub = path.join(dir, "nested", "scripts");
        emitScriptsTypes(sub);
        expect(fs.existsSync(path.join(sub, "_types", "toolkit.d.ts"))).toBe(true);
    });
});
