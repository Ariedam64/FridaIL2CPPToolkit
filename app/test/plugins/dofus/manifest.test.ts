import { describe, it, expect, beforeEach } from "vitest";
import { Window } from "happy-dom";
import dofusManifest from "../../../plugins/dofus/manifest";
import type { PluginPageContext } from "../../../frontend/core/plugin-types";

describe("dofus manifest", () => {
    it("exports a valid GamePlugin shape", () => {
        expect(dofusManifest.id).toBe("dofus");
        expect(dofusManifest.gameName).toBe("dofus");
        expect(dofusManifest.displayName).toBe("Dofus");
        expect(dofusManifest.navIcon).toBe("crown");
        expect(typeof dofusManifest.rootPage).toBe("function");
    });

    it("rootPage() lazy-resolves to a module with a mount function, which renders sub-tabs", async () => {
        const window = new Window();
        (globalThis as { document?: unknown }).document = window.document;
        const host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;

        const m = await dofusManifest.rootPage();
        expect(typeof m.default.mount).toBe("function");

        const ctx: PluginPageContext = {
            profile: { gameName: "dofus", buildId: "abcd1234" },
            currentSubTab: null,
            setSubTab: () => undefined,
        };
        m.default.mount(host, ctx);

        const subnav = host.querySelector("[data-testid='dofus-subnav']");
        expect(subnav).not.toBeNull();
        const buttons = host.querySelectorAll("[data-sub]");
        expect(buttons.length).toBe(3);  // map, items, state
    });
});
