import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";

import { expandHome } from "../../../backend/core/paths";

describe("expandHome", () => {
    it("returns empty string unchanged", () => {
        expect(expandHome("")).toBe("");
    });

    it("expands a bare ~", () => {
        expect(expandHome("~")).toBe(os.homedir());
    });

    it("expands ~/foo to <home>/foo", () => {
        expect(expandHome("~/foo")).toBe(path.join(os.homedir(), "foo"));
    });

    it("expands ~/.frida-toolkit/profiles", () => {
        expect(expandHome("~/.frida-toolkit/profiles")).toBe(
            path.join(os.homedir(), ".frida-toolkit/profiles"),
        );
    });

    it("leaves an absolute path untouched", () => {
        const abs = path.resolve("/tmp/foo");
        expect(expandHome(abs)).toBe(abs);
    });

    it("does not expand a tilde mid-string", () => {
        expect(expandHome("/foo/~bar")).toBe("/foo/~bar");
    });
});
