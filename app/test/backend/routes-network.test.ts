import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../backend/core/plugin-storage.js";
import { FrameStore } from "../../backend/core/network/frame-store.js";
import { SerializerConfigStore } from "../../backend/core/network/serializer-config.js";
import { mountNetwork } from "../../backend/routes/network.js";
import type { SerializerEntry } from "../../backend/core/network/types.js";

interface FakeSession {
    frameStore(): FrameStore | null;
    serializerConfigStore(): SerializerConfigStore | null;
    fridaClient: { call<T>(method: string, args?: unknown[]): Promise<T> };
}

const ENTRY: SerializerEntry = {
    source: "manual", direction: "send",
    className: "ecu", ns: "Game.Net",
    methodName: "xbe", methodSignature: "(IMessage):Void",
    paramIndex: 0, addedAt: "2026-05-06T10:00:00.000Z",
};

let tmp: string;
let frames: FrameStore;
let cfg: SerializerConfigStore;
let session: FakeSession;
let app: express.Express;
let rpcCalls: Array<{ method: string; args: unknown[] }>;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "net-routes-"));
    frames = new FrameStore(100);
    cfg = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
    rpcCalls = [];
    session = {
        frameStore: () => frames,
        serializerConfigStore: () => cfg,
        fridaClient: {
            async call<T>(method: string, args: unknown[] = []): Promise<T> {
                rpcCalls.push({ method, args });
                if (method === "armNetworkCapture") return { installed: 1, failed: [] } as unknown as T;
                if (method === "disarmNetworkCapture") return { reverted: 0 } as unknown as T;
                if (method === "validateSerializerEntry") return { valid: true } as unknown as T;
                return null as unknown as T;
            },
        },
    };
    app = express();
    app.use(express.json());
    mountNetwork(app, { session: session as any });
});

describe("network routes", () => {
    it("GET /api/network/frames returns 503 when not attached", async () => {
        session.frameStore = () => null;
        const res = await request(app).get("/api/network/frames");
        expect(res.status).toBe(503);
    });

    it("GET /api/network/frames returns the list", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).get("/api/network/frames");
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(1);
    });

    it("GET /api/network/frames passes filter, direction, sinceId, limit", async () => {
        for (let i = 0; i < 5; i++) {
            frames.push({ timestamp: i, direction: i % 2 ? "in" : "out", typeKey: { ns: null, className: "A" }, fields: [] });
        }
        const res = await request(app).get("/api/network/frames?direction=in&limit=2");
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(2);
        expect(res.body.frames.every((f: any) => f.direction === "in")).toBe(true);
    });

    it("GET /api/network/types returns aggregated summary", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        frames.push({ timestamp: 2, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).get("/api/network/types");
        expect(res.status).toBe(200);
        expect(res.body.types).toHaveLength(1);
        expect(res.body.types[0].count).toBe(2);
    });

    it("GET /api/network/types/:typeKey/instances returns frames of that type", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: "X", className: "A" }, fields: [] });
        frames.push({ timestamp: 2, direction: "in", typeKey: { ns: null, className: "B" }, fields: [] });
        const res = await request(app).get(`/api/network/types/${encodeURIComponent("X~A")}/instances`);
        expect(res.status).toBe(200);
        expect(res.body.frames).toHaveLength(1);
        expect(res.body.frames[0].typeKey.className).toBe("A");
    });

    it("DELETE /api/network/frames clears the buffer", async () => {
        frames.push({ timestamp: 1, direction: "in", typeKey: { ns: null, className: "A" }, fields: [] });
        const res = await request(app).delete("/api/network/frames");
        expect(res.status).toBe(200);
        expect(frames.count()).toBe(0);
    });

    it("GET /api/network/serializer-config returns the persisted config", async () => {
        cfg.add(ENTRY);
        const res = await request(app).get("/api/network/serializer-config");
        expect(res.status).toBe(200);
        expect(res.body.config.entries).toHaveLength(1);
    });

    it("PUT /api/network/serializer-config replaces all entries", async () => {
        const res = await request(app)
            .put("/api/network/serializer-config")
            .send({ entries: [ENTRY] });
        expect(res.status).toBe(200);
        expect(cfg.get().entries).toHaveLength(1);
    });

    it("PUT /api/network/serializer-config rejects malformed body", async () => {
        const res = await request(app)
            .put("/api/network/serializer-config")
            .send({ entries: "not-an-array" });
        expect(res.status).toBe(400);
    });

    it("POST /api/network/start returns 400 when config is empty", async () => {
        const res = await request(app).post("/api/network/start");
        expect(res.status).toBe(400);
    });

    it("POST /api/network/start arms agent capture", async () => {
        cfg.add(ENTRY);
        const res = await request(app).post("/api/network/start");
        expect(res.status).toBe(200);
        expect(rpcCalls.find((c) => c.method === "armNetworkCapture")).toBeTruthy();
    });

    it("POST /api/network/stop disarms", async () => {
        const res = await request(app).post("/api/network/stop");
        expect(res.status).toBe(200);
        expect(rpcCalls.find((c) => c.method === "disarmNetworkCapture")).toBeTruthy();
    });
});
