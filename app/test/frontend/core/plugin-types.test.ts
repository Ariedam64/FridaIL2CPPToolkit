import { describe, it, expect } from "vitest";
import { defineGamePlugin, BUILTIN_TABS } from "../../../frontend/core/plugin-types";

describe("plugin-types", () => {
    it("defineGamePlugin is identity (returns the input unchanged)", () => {
        const p = defineGamePlugin({
            id: "test",
            displayName: "Test",
            gameName: "test",
            navIcon: "box",
            rootPage: async () => ({ default: { mount: () => undefined } }),
        });
        expect(p.id).toBe("test");
        expect(typeof p.rootPage).toBe("function");
    });

    it("BUILTIN_TABS includes the 7 known toolkit tabs", () => {
        expect(BUILTIN_TABS.has("explorer")).toBe(true);
        expect(BUILTIN_TABS.has("hooks")).toBe(true);
        expect(BUILTIN_TABS.has("network")).toBe(true);
        expect(BUILTIN_TABS.has("bookmarks")).toBe(true);
        expect(BUILTIN_TABS.has("migrations")).toBe(true);
        expect(BUILTIN_TABS.has("instances")).toBe(true);
        expect(BUILTIN_TABS.has("scripts")).toBe(true);
    });

    it("BUILTIN_TABS does NOT include arbitrary plugin ids", () => {
        expect(BUILTIN_TABS.has("dofus")).toBe(false);
        expect(BUILTIN_TABS.has("tof")).toBe(false);
    });
});
