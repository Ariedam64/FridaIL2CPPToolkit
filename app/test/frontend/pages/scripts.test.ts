// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../../frontend/core/ws.js", () => ({ subscribe: () => () => {} }));

const SCRIPTS_PAYLOAD = {
    scripts: [
        { id: "echo", status: "loaded", definition: { name: "echo", description: "echoes", params: { msg: { type: "string", required: true } } }, filePath: "/p/echo.ts", loadedAt: "" },
        { id: "boom", status: "compile-error", error: "boom", filePath: "/p/boom.ts", loadedAt: "" },
    ],
};

function setupFetch() {
    (globalThis as { fetch?: unknown }).fetch = vi.fn(async (url: string) => {
        if (url === "/api/scripts") {
            return {
                ok: true,
                json: async () => SCRIPTS_PAYLOAD,
            } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as Response;
    }) as never;
    return (globalThis as { fetch: ReturnType<typeof vi.fn> }).fetch;
}

describe("scripts page", () => {
    let host: HTMLElement;

    beforeEach(() => {
        vi.resetModules();
        host = document.createElement("div") as HTMLElement;
        document.body.appendChild(host);
        setupFetch();
    });

    it("renders the script list", async () => {
        const { renderScriptsPage } = await import("../../../frontend/pages/scripts");
        await renderScriptsPage(host);
        const items = host.querySelectorAll("[data-testid='script-item']");
        expect(items.length).toBe(2);
    });

    it("clicking a loaded script shows the param form", async () => {
        const { renderScriptsPage } = await import("../../../frontend/pages/scripts");
        await renderScriptsPage(host);
        const echoItem = host.querySelector("[data-script-id='echo']") as HTMLElement;
        echoItem.click();
        const input = host.querySelector("[data-param='msg']") as HTMLInputElement;
        expect(input).not.toBeNull();
    });

    it("compile-error script shows error inline, no run button", async () => {
        const { renderScriptsPage } = await import("../../../frontend/pages/scripts");
        await renderScriptsPage(host);
        const boomItem = host.querySelector("[data-script-id='boom']") as HTMLElement;
        boomItem.click();
        expect(host.querySelector("[data-testid='script-error']")?.textContent).toMatch(/boom/);
        expect(host.querySelector("[data-testid='run-btn']")).toBeNull();
    });

    it("submitting form posts to /api/scripts/:id/run", async () => {
        const fetchMock = setupFetch();
        const { renderScriptsPage } = await import("../../../frontend/pages/scripts");
        await renderScriptsPage(host);
        (host.querySelector("[data-script-id='echo']") as HTMLElement).click();
        (host.querySelector("[data-param='msg']") as HTMLInputElement).value = "hello";
        // Re-mock for the run call
        fetchMock.mockResolvedValueOnce({
            ok: true, json: async () => ({ runId: "r-99" }),
        } as Response);
        (host.querySelector("[data-testid='run-btn']") as HTMLButtonElement).click();
        // Wait a tick
        await new Promise((r) => setTimeout(r, 10));
        const calls = fetchMock.mock.calls;
        const runCall = calls.find((c) => String(c[0]).endsWith("/api/scripts/echo/run"));
        expect(runCall).toBeDefined();
        expect(JSON.parse((runCall![1] as { body: string }).body)).toEqual({ params: { msg: "hello" } });
    });

    it("appends WS log events to the console", async () => {
        const { renderScriptsPage } = await import("../../../frontend/pages/scripts");
        await renderScriptsPage(host);
        // Make detail panel render (which creates the console element).
        (host.querySelector("[data-script-id='echo']") as HTMLElement).click();

        // Simulate a WS event arriving
        const evt = new (window.CustomEvent as unknown as typeof CustomEvent)("script-log", {
            detail: { runId: "r-99", level: "info", args: ["hello", 42], ts: "" },
        });
        host.dispatchEvent(evt);
        const console_ = host.querySelector("[data-testid='console']");
        expect(console_?.textContent).toMatch(/hello/);
    });
});
