import { describe, it, expect, beforeEach, vi } from "vitest";
import { Window } from "happy-dom";
import { mountMap } from "../../../../plugins/dofus/pages/map";
import type { PluginPageContext } from "../../../../frontend/core/plugin-types";

// happy-dom Canvas2D is missing — mock getContext globally for the page tests.
function patchCanvasMock(window: Window): void {
    const proto = (window.HTMLCanvasElement as unknown as { prototype: HTMLCanvasElement }).prototype;
    proto.getContext = function () {
        return {
            clearRect: () => undefined, fillRect: () => undefined, strokeRect: () => undefined,
            beginPath: () => undefined, moveTo: () => undefined, lineTo: () => undefined,
            closePath: () => undefined, fill: () => undefined, stroke: () => undefined,
            fillText: () => undefined,
            fillStyle: "", strokeStyle: "", lineWidth: 0, font: "",
        } as unknown as CanvasRenderingContext2D;
    } as never;
}

const makeCtx = (): PluginPageContext => ({
    profile: { gameName: "dofus", buildId: "abc" },
    currentSubTab: "map",
    setSubTab: () => undefined,
});

describe("mountMap", () => {
    let host: HTMLElement;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        const window = new Window();
        patchCanvasMock(window);
        const document = window.document as unknown as Document;
        (globalThis as { document?: unknown }).document = document;
        host = document.createElement("div") as unknown as HTMLElement;

        fetchMock = vi.fn(async (url: string) => {
            if (url === "/api/dofus/worlds") {
                return { ok: true, json: async () => ({
                    worlds: [
                        { id: 1, name: "Amakna", mapCount: 2 },
                        { id: 10, name: "Frigost", mapCount: 1 },
                    ],
                }) } as Response;
            }
            if (url === "/api/dofus/maps/list?world=1") {
                return { ok: true, json: async () => ({
                    world: 1,
                    maps: [
                        { mapId: 100, posX: 0, posY: 0, subAreaId: 1, areaId: 0, name: "M100" },
                        { mapId: 200, posX: 1, posY: 0, subAreaId: 1, areaId: 0, name: "M200" },
                    ],
                }) } as Response;
            }
            if (url.startsWith("/api/dofus/maps/")) {
                return { ok: true, json: async () => ({
                    mapId: 100, name: "M100", posX: 0, posY: 0, subAreaId: 1, areaId: 0,
                    neighbours: [], cells: Array(560).fill([0,0,0,0,0]),
                }) } as Response;
            }
            return { ok: false, status: 404, json: async () => ({}) } as Response;
        });
        (globalThis as { fetch?: unknown }).fetch = fetchMock;
    });

    it("populates the world dropdown from /api/dofus/worlds", async () => {
        await mountMap(host, makeCtx());
        // Wait for promises to resolve
        await new Promise((r) => setTimeout(r, 10));
        const select = host.querySelector<HTMLSelectElement>("[data-testid='world-select']")!;
        expect(select.options).toHaveLength(2);
        expect(select.options[0].textContent).toMatch(/Amakna/);
    });

    it("renders the world canvas after fetching maps for the default world", async () => {
        await mountMap(host, makeCtx());
        await new Promise((r) => setTimeout(r, 30));
        // /api/dofus/maps/list?world=1 should have been called
        expect(fetchMock.mock.calls.some(([url]) => url === "/api/dofus/maps/list?world=1")).toBe(true);
        const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']");
        expect(canvas).not.toBeNull();
        // Canvas dimensions set (via renderWorldCanvas)
        expect(canvas!.width).toBeGreaterThan(0);
    });

    it("clicking a tile triggers /api/dofus/maps/:mapId and renders cell-grid in the side panel", async () => {
        await mountMap(host, makeCtx());
        await new Promise((r) => setTimeout(r, 30));

        const canvas = host.querySelector<HTMLCanvasElement>("[data-testid='world-canvas']")!;
        // Simulate click at the px coords of the first map (posX=0, posY=0).
        // tileSize default 14, padding 4 → tile at px=4,py=4. Click at (8,8) lands inside.
        const rect = { left: 0, top: 0 } as DOMRect;
        canvas.getBoundingClientRect = () => rect as DOMRect;
        const evt = new (host.ownerDocument!.defaultView as unknown as { Event: typeof Event }).Event("click", { bubbles: true });
        Object.defineProperty(evt, "clientX", { value: 8 });
        Object.defineProperty(evt, "clientY", { value: 8 });
        canvas.dispatchEvent(evt);

        await new Promise((r) => setTimeout(r, 30));
        const detailFetch = fetchMock.mock.calls.find(([url]) => /\/api\/dofus\/maps\/\d+$/.test(String(url)));
        expect(detailFetch).toBeDefined();
        const panel = host.querySelector<HTMLElement>("[data-testid='cell-grid-panel']")!;
        expect(panel.querySelector("[data-testid='cell-grid-canvas']")).not.toBeNull();
    });
});
