import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { mountPluginPage } from "../../../frontend/core/mount-plugin-page";
import type { GamePlugin, PluginPageModule } from "../../../frontend/core/plugin-types";

function fakePlugin(rootPage: () => Promise<{ default: PluginPageModule }>): GamePlugin {
    return {
        id: "dofus", displayName: "Dofus", gameName: "dofus", navIcon: "crown",
        rootPage,
    };
}

describe("mountPluginPage", () => {
    let host: HTMLElement;
    let onAttachClick: ReturnType<typeof vi.fn>;
    let setSubTab: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;
        (globalThis as { document?: unknown }).document = window.document;
        onAttachClick = vi.fn();
        setSubTab = vi.fn();
    });

    it("mounts the plugin's root page when profile.gameName matches", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: { gameName: "dofus", buildId: "abc123" },
            currentSubTab: "map",
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).toHaveBeenCalledTimes(1);
        const ctx = pageMount.mock.calls[0][1];
        expect(ctx.profile.gameName).toBe("dofus");
        expect(ctx.currentSubTab).toBe("map");
        expect(typeof ctx.setSubTab).toBe("function");
    });

    it("renders the not-attached notice when profile is null", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: null,
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).not.toHaveBeenCalled();
        expect(host.textContent?.toLowerCase()).toContain("no process attached");
    });

    it("renders the not-attached notice when gameName mismatches", async () => {
        const pageMount = vi.fn();
        const plugin = fakePlugin(async () => ({ default: { mount: pageMount } }));

        await mountPluginPage(host, plugin, {
            profile: { gameName: "tof", buildId: "xyz" },
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(pageMount).not.toHaveBeenCalled();
        expect(host.textContent).toContain("Currently attached to");
        expect(host.textContent).toContain("tof");
    });

    it("falls back to an error message if rootPage import rejects", async () => {
        const plugin = fakePlugin(async () => { throw new Error("boom: chunk load failed"); });

        await mountPluginPage(host, plugin, {
            profile: { gameName: "dofus", buildId: "abc" },
            currentSubTab: null,
            setSubTab,
            onAttachClick,
        });

        expect(host.textContent).toContain("Failed to load");
        expect(host.textContent).toContain("boom: chunk load failed");
    });
});
