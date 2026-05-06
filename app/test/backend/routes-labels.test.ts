// app/test/backend/routes-labels.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LabelStore } from "../../backend/core/labels.js";
import { mountLabels } from "../../backend/routes/labels.js";

function makeSession(store: LabelStore) {
    return { profile: () => ({ labels: store }) };
}

let tmpDir: string;
let store: LabelStore;
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labels-routes-"));
    store = new LabelStore(path.join(tmpDir, "labels.json"));
    app = express();
    app.use(express.json());
    mountLabels(app, { session: makeSession(store) as any });
});

describe("labels routes", () => {
    it("GET /api/labels returns the bulk export", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        const res = await request(app).get("/api/labels");
        expect(res.status).toBe(200);
        expect(res.body.classes.egq.label).toBe("HaapiService");
    });

    it("POST /api/labels/class sets a class label", async () => {
        const res = await request(app)
            .post("/api/labels/class")
            .send({ key: { className: "egq" }, label: "HaapiService" });
        expect(res.status).toBe(200);
        expect(store.get({ kind: "class", className: "egq" })).toBe("HaapiService");
    });

    it("POST /api/labels/method sets a method label", async () => {
        const res = await request(app)
            .post("/api/labels/method")
            .send({ key: { className: "egq", methodName: "ywp" }, label: "Consume" });
        expect(res.status).toBe(200);
        expect(store.get({ kind: "method", className: "egq", methodName: "ywp" })).toBe("Consume");
    });

    it("POST /api/labels/class with remove:true removes the label", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        await request(app)
            .post("/api/labels/class")
            .send({ key: { className: "egq" }, remove: true });
        expect(store.get({ kind: "class", className: "egq" })).toBeNull();
    });

    it("POST /api/labels/undo + redo work end-to-end", async () => {
        store.set({ kind: "class", className: "egq" }, "HaapiService");
        await request(app).post("/api/labels/undo");
        expect(store.get({ kind: "class", className: "egq" })).toBeNull();
        await request(app).post("/api/labels/redo");
        expect(store.get({ kind: "class", className: "egq" })).toBe("HaapiService");
    });

    it("returns 503 when no profile attached", async () => {
        const app2 = express();
        app2.use(express.json());
        mountLabels(app2, { session: { profile: () => null } as any });
        const res = await request(app2).get("/api/labels");
        expect(res.status).toBe(503);
    });
});
