import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { renderPluginNotAttached } from "../../../frontend/components/plugin-not-attached";
import type { GamePlugin } from "../../../frontend/core/plugin-types";

const dummyPlugin: GamePlugin = {
    id: "dofus", displayName: "Dofus", gameName: "dofus", navIcon: "crown",
    rootPage: async () => ({ default: { mount: () => undefined } }),
};

describe("renderPluginNotAttached", () => {
    let host: HTMLElement;
    let onAttachClick: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        host = (window.document as unknown as Document).createElement("div") as unknown as HTMLElement;
        onAttachClick = vi.fn();
    });

    it("renders the 'no process attached' message when currentGameName is null", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: null, onAttachClick });
        expect(host.textContent).toContain("Dofus plugin");
        expect(host.textContent).toContain("dofus");
        expect(host.textContent?.toLowerCase()).toContain("no process attached");
    });

    it("renders the 'currently attached to X' message when gameName mismatches", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: "tof", onAttachClick });
        expect(host.textContent).toContain("Currently attached to");
        expect(host.textContent).toContain("tof");
    });

    it("attach button click invokes onAttachClick", () => {
        renderPluginNotAttached(host, { plugin: dummyPlugin, currentGameName: null, onAttachClick });
        const btn = host.querySelector<HTMLButtonElement>("[data-testid='attach-btn']")!;
        btn.click();
        expect(onAttachClick).toHaveBeenCalledTimes(1);
    });
});
