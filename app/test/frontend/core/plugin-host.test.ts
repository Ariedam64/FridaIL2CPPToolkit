import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRegistry } from "../../../frontend/core/plugin-host";
import type { GamePlugin } from "../../../frontend/core/plugin-types";

const fakePlugin = (id: string): GamePlugin => ({
    id,
    displayName: id,
    gameName: id,
    navIcon: "box",
    rootPage: async () => ({ default: { mount: () => undefined } }),
});

describe("plugin-host createRegistry", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("loads valid manifests into the registry", () => {
        const reg = createRegistry({
            "/path/dofus/manifest.ts": { default: fakePlugin("dofus") },
            "/path/tof/manifest.ts":   { default: fakePlugin("tof") },
        });
        expect(reg.size).toBe(2);
        expect(reg.get("dofus")?.id).toBe("dofus");
        expect(reg.get("tof")?.id).toBe("tof");
    });

    it("rejects plugins whose id collides with a built-in tab", () => {
        const reg = createRegistry({
            "/path/hooks/manifest.ts": { default: fakePlugin("hooks") },
            "/path/dofus/manifest.ts": { default: fakePlugin("dofus") },
        });
        expect(reg.has("hooks")).toBe(false);
        expect(reg.has("dofus")).toBe(true);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/built-in.*hooks/));
    });

    it("rejects duplicate ids (keeps the first, warns on the rest)", () => {
        const reg = createRegistry({
            "/path/a/manifest.ts": { default: fakePlugin("dup") },
            "/path/b/manifest.ts": { default: { ...fakePlugin("dup"), displayName: "Second" } },
        });
        expect(reg.size).toBe(1);
        expect(reg.get("dup")?.displayName).toBe("dup");  // first one kept
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/duplicate.*dup/));
    });

    it("returns empty registry when no modules", () => {
        const reg = createRegistry({});
        expect(reg.size).toBe(0);
    });
});
