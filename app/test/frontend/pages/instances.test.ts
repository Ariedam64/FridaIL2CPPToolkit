// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../frontend/core/ws.js", () => ({ subscribe: () => () => {} }));

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

beforeEach(() => {
    fetchMock.mockReset();
    vi.resetModules();
});

function mockEndpoints(state: { instances?: any[]; readOnly?: boolean; history?: any[]; fields?: any[] }): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        if (url === "/api/instances/list" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ instances: state.instances ?? [] }) });
        }
        if (url === "/api/instances/read-only" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: state.readOnly ?? true }) });
        }
        if (url === "/api/instances/history" && method === "GET") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ entries: state.history ?? [] }) });
        }
        if (url.match(/\/read-fields$/) && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ alive: true, fields: state.fields ?? [] }) });
        }
        if (url === "/api/instances/read-only" && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ enabled: !(state.readOnly ?? true) }) });
        }
        if (url.match(/\/write-field$/) && method === "POST") {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ before: "0", after: "9999" }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
}

describe("instances page", () => {
    it("renders empty state with toolbar buttons", async () => {
        mockEndpoints({});
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("New capture");
        expect(host.textContent).toContain("Recipes");
        expect(host.textContent).toContain("Read-Only");
    });

    it("renders captured instances in sidebar", async () => {
        mockEndpoints({
            instances: [
                { key: "player", className: "Player", handle: "0x1", capturedAt: "2026-05-07", capturedVia: "captureViaGC", isAlive: true },
                { key: "inv",    className: "Inventory", handle: "0x2", capturedAt: "2026-05-07", capturedVia: "captureFieldValue", isAlive: true },
            ],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("player");
        expect(host.textContent).toContain("Player@0x1");
        expect(host.textContent).toContain("inv");
    });

    it("Read-Only ON disables write inputs", async () => {
        mockEndpoints({
            readOnly: true,
            instances: [{ key: "p", className: "P", handle: "0x1", capturedAt: "x", capturedVia: "captureViaGC", isAlive: true }],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.querySelector<HTMLInputElement>('[data-edit]')).toBeNull();
    });

    it("Read-Only OFF + Save sends POST /write-field", async () => {
        mockEndpoints({
            readOnly: false,
            instances: [{ key: "p", className: "P", handle: "0x1", capturedAt: "x", capturedVia: "captureViaGC", isAlive: true }],
            fields: [{ name: "health", typeName: "Int32", kind: "scalar", preview: "100", rawValue: 100, isWritable: true }],
        });
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        const input = host.querySelector<HTMLInputElement>('[data-edit="health"]')!;
        input.value = "9999";
        const btn = host.querySelector<HTMLButtonElement>('[data-save="health"]')!;
        btn.click();
        await new Promise((r) => setTimeout(r, 10));
        const writeCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith("/write-field"));
        expect(writeCall).toBeDefined();
        const body = JSON.parse((writeCall![1] as RequestInit).body as string);
        expect(body.fieldName).toBe("health");
        expect(body.value).toBe(9999);
    });

    it("Toggle Read-Only sends POST /read-only", async () => {
        mockEndpoints({ readOnly: true });
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        const btn = host.querySelector<HTMLButtonElement>("#ip-toggle-ro")!;
        btn.click();
        await new Promise((r) => setTimeout(r, 10));
        const toggleCall = fetchMock.mock.calls.find((c) => c[0] === "/api/instances/read-only" && (c[1] as RequestInit)?.method === "POST");
        expect(toggleCall).toBeDefined();
    });

    it("renders history panel with WRITE/CALL tags", async () => {
        mockEndpoints({
            history: [
                { id: "1", timestamp: "2026-05-07T14:23:11Z", action: "write", target: { instanceKey: "p", member: "health" }, before: "100", after: "9999", success: true },
                { id: "2", timestamp: "2026-05-07T14:23:05Z", action: "call",  target: { instanceKey: "p", member: "Heal" }, callResult: "void", success: true },
            ],
        });
        const { mountInstancesPage } = await import("../../../frontend/pages/instances");
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountInstancesPage(host);
        await new Promise((r) => setTimeout(r, 10));
        expect(host.textContent).toContain("WRITE");
        expect(host.textContent).toContain("CALL");
        expect(host.textContent).toContain("100");
        expect(host.textContent).toContain("9999");
    });
});
