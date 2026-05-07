// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mountMigrationsPage } from "../../../frontend/pages/migrations";

vi.mock("../../../frontend/core/ws.js", () => ({
    subscribe: () => () => {},
}));

const fetchMock = vi.fn();
global.fetch = fetchMock as any;

beforeEach(() => {
    fetchMock.mockReset();
});

function mockMigrations(result: any): void {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
        if (url === "/api/migrations" && (!init || init.method === undefined || init.method === "GET")) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ result }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
    });
}

describe("migrations page", () => {
    it("renders an empty state when nothing to migrate", async () => {
        mockMigrations({ auto: [], review: [], lost: [] });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));
        expect(host.textContent).toContain("No REVIEWs pending");
    });

    it("renders REVIEW rows with candidate buttons", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "class", className: "fzc" },
                oldObf: "fzc",
                label: "Encoder",
                candidates: [
                    { newObf: "abc", score: 0.92, reason: "structural similarity 0.92" },
                    { newObf: "def", score: 0.85, reason: "structural similarity 0.85" },
                ],
            }],
            lost: [],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));
        expect(host.textContent).toContain("Encoder");
        expect(host.textContent).toContain("abc");
        expect(host.querySelectorAll('[data-action="accept"]').length).toBe(2);
    });

    it("clicking Accept sends polymorphic payload to /api/migrations/accept", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "field", className: "newCls", fieldName: "" },
                oldObf: "oldCls.emjv",
                label: "playerId",
                candidates: [{ newObf: "newCls.aaa", score: 0.85, reason: "..." }],
                parentClassMigration: "oldCls",
            }],
            lost: [],
        });
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));

        const acceptBtn = host.querySelector<HTMLButtonElement>('[data-action="accept"]')!;
        acceptBtn.click();
        await new Promise((r) => setTimeout(r, 0));

        const acceptCall = fetchMock.mock.calls.find((c) => c[0] === "/api/migrations/accept");
        expect(acceptCall).toBeDefined();
        const body = JSON.parse(acceptCall![1].body);
        expect(body.key).toEqual({ kind: "field", className: "newCls", fieldName: "aaa" });
        expect(body.oldObf).toBe("oldCls.emjv");
    });

    it("Accept-top-all sends to /api/migrations/accept-top-all after confirm", async () => {
        mockMigrations({
            auto: [],
            review: [{
                key: { kind: "class", className: "fzc" },
                oldObf: "fzc",
                label: "Encoder",
                candidates: [{ newObf: "abc", score: 0.92, reason: "..." }],
            }],
            lost: [],
        });
        global.confirm = vi.fn(() => true);
        const host = document.createElement("div");
        document.body.appendChild(host);
        mountMigrationsPage(host);
        await new Promise((r) => setTimeout(r, 0));

        const btn = host.querySelector<HTMLButtonElement>("#mig-accept-all")!;
        btn.click();
        await new Promise((r) => setTimeout(r, 0));

        const bulkCall = fetchMock.mock.calls.find((c) => c[0] === "/api/migrations/accept-top-all");
        expect(bulkCall).toBeDefined();
    });
});
