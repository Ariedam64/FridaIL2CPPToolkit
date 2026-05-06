import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { LabelStore } from "../../backend/core/labels.js";
import { mountMigrations } from "../../backend/routes/migrations.js";

function makeFakeSession(opts: { hasProfile: boolean; hasMigrations: boolean }) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-routes-"));
    const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
    const profile: any = opts.hasProfile ? { labels: labelStore } : null;
    const review = [
        {
            key: { kind: "class", className: "ecu" },
            label: "OldClass",
            oldObf: "ecu",
            candidates: [{ newObf: "egq", score: 0.92, reason: "structural match 0.92" }],
        },
    ];
    const migrations = opts.hasMigrations ? { result: { auto: [], review, lost: [] } } : null;
    return {
        profile: () => profile,
        migrations: () => migrations,
        labelStore,
    };
}

let app: express.Express;

function build(opts: { hasProfile: boolean; hasMigrations: boolean }) {
    const session = makeFakeSession(opts);
    app = express();
    app.use(express.json());
    mountMigrations(app, { session: session as any });
    return session;
}

describe("migrations routes", () => {
    it("GET /api/migrations returns empty result when no migrations", async () => {
        build({ hasProfile: true, hasMigrations: false });
        const res = await request(app).get("/api/migrations");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ result: { auto: [], review: [], lost: [] } });
    });

    it("GET /api/migrations returns the active migration result", async () => {
        build({ hasProfile: true, hasMigrations: true });
        const res = await request(app).get("/api/migrations");
        expect(res.status).toBe(200);
        expect(res.body.result.review).toHaveLength(1);
    });

    it("POST /api/migrations/accept moves entry from review to auto + sets label", async () => {
        const session = build({ hasProfile: true, hasMigrations: true });
        const res = await request(app)
            .post("/api/migrations/accept")
            .send({ oldObf: "ecu", newObf: "egq" });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "class", className: "egq" })).toBe("OldClass");
        const m = session.migrations()!;
        expect(m.result.review).toHaveLength(0);
        expect(m.result.auto).toHaveLength(1);
        expect(m.result.auto[0].newObf).toBe("egq");
    });

    it("POST /api/migrations/accept returns 400 on missing oldObf/newObf", async () => {
        build({ hasProfile: true, hasMigrations: true });
        const res = await request(app).post("/api/migrations/accept").send({ oldObf: "ecu" });
        expect(res.status).toBe(400);
    });

    it("POST /api/migrations/accept returns 404 on unknown oldObf", async () => {
        build({ hasProfile: true, hasMigrations: true });
        const res = await request(app)
            .post("/api/migrations/accept")
            .send({ oldObf: "doesnotexist", newObf: "egq" });
        expect(res.status).toBe(404);
    });

    it("POST /api/migrations/reject moves entry from review to lost", async () => {
        const session = build({ hasProfile: true, hasMigrations: true });
        const res = await request(app)
            .post("/api/migrations/reject")
            .send({ oldObf: "ecu" });
        expect(res.status).toBe(200);
        const m = session.migrations()!;
        expect(m.result.review).toHaveLength(0);
        expect(m.result.lost).toHaveLength(1);
    });

    it("returns 503 when no migrations active (accept)", async () => {
        build({ hasProfile: true, hasMigrations: false });
        const res = await request(app)
            .post("/api/migrations/accept")
            .send({ oldObf: "ecu", newObf: "egq" });
        expect(res.status).toBe(503);
    });
});
