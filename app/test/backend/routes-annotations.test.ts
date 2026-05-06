import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AnnotationStore } from "../../backend/core/annotations.js";
import { mountAnnotations } from "../../backend/routes/annotations.js";

let tmpDir: string;
let store: AnnotationStore;
let app: express.Express;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "annot-routes-"));
    store = new AnnotationStore(path.join(tmpDir, "annotations.json"));
    app = express();
    app.use(express.json());
    mountAnnotations(app, { session: { profile: () => ({ annotations: store }) } as any });
});

describe("annotations routes", () => {
    it("GET /api/annotations returns bookmarks + notes lists", async () => {
        store.toggleBookmark({ kind: "class", className: "egq" });
        store.setNote({ kind: "class", className: "egq" }, "important");
        const res = await request(app).get("/api/annotations");
        expect(res.status).toBe(200);
        expect(res.body.bookmarks).toContainEqual({ kind: "class", className: "egq" });
        expect(res.body.notes.find((n: any) => n.key.className === "egq").markdown).toBe("important");
    });

    it("POST /api/annotations/bookmark toggles", async () => {
        await request(app).post("/api/annotations/bookmark")
            .send({ key: { kind: "class", className: "egq" } });
        expect(store.isBookmarked({ kind: "class", className: "egq" })).toBe(true);
        await request(app).post("/api/annotations/bookmark")
            .send({ key: { kind: "class", className: "egq" } });
        expect(store.isBookmarked({ kind: "class", className: "egq" })).toBe(false);
    });

    it("POST /api/annotations/note sets and removes", async () => {
        await request(app).post("/api/annotations/note")
            .send({ key: { kind: "class", className: "egq" }, markdown: "hello" });
        expect(store.getNote({ kind: "class", className: "egq" })).toBe("hello");
        await request(app).post("/api/annotations/note")
            .send({ key: { kind: "class", className: "egq" }, remove: true });
        expect(store.getNote({ kind: "class", className: "egq" })).toBeNull();
    });
});
