// app/test/backend/routes-api-call.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { EventEmitter } from "node:events";

import { mountApiCall } from "../../backend/routes/api-call.js";

class FakeFridaClient extends EventEmitter {
    isAttached(): boolean { return true; }
    async call<T>(method: string, args: unknown[] = []): Promise<T> {
        if (method === "echo") return args[0] as T;
        if (method === "boom") throw new Error("kaboom");
        throw new Error(`unknown method ${method}`);
    }
}

let app: express.Express;

beforeEach(() => {
    app = express();
    app.use(express.json());
    mountApiCall(app, { fridaClient: new FakeFridaClient() as any });
});

describe("POST /api/call", () => {
    it("returns the RPC result on success", async () => {
        const res = await request(app)
            .post("/api/call")
            .send({ method: "echo", args: ["hello"] });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: "hello" });
    });

    it("returns 500 with error message on RPC failure", async () => {
        const res = await request(app)
            .post("/api/call")
            .send({ method: "boom" });
        expect(res.status).toBe(500);
        expect(res.body.error).toContain("kaboom");
    });

    it("returns 400 when method is missing", async () => {
        const res = await request(app).post("/api/call").send({});
        expect(res.status).toBe(400);
    });

    it("returns 503 when not attached", async () => {
        const detached = new (class extends FakeFridaClient {
            isAttached() { return false; }
        })();
        const app2 = express();
        app2.use(express.json());
        mountApiCall(app2, { fridaClient: detached as any });
        const res = await request(app2).post("/api/call").send({ method: "echo", args: [] });
        expect(res.status).toBe(503);
    });
});
