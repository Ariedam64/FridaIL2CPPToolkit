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
        applyClassPass2: (_oldObf: string, _newObf: string) => ({ auto: [], review: [], lost: [] }),
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

describe("migrations routes — polymorphic accept", () => {
    function makeFakeSessionPoly(reviewItems: any[]) {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-poly-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const profile: any = { labels: labelStore };
        const migrations = { result: { auto: [], review: reviewItems, lost: [] } };
        return {
            profile: () => profile,
            migrations: () => migrations,
            labelStore,
            applyClassPass2: (_oldObf: string, _newObf: string) => ({ auto: [], review: [], lost: [] }),
        };
    }

    it("accepts a field key and writes the label under {kind:field}", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "field", className: "newCls", fieldName: "" },
                label: "playerId",
                oldObf: "oldCls.emjv",
                candidates: [
                    { newObf: "newCls.aaa", score: 0.9, reason: "type+ordinal" },
                    { newObf: "newCls.bbb", score: 0.7, reason: "..." },
                ],
                parentClassMigration: "oldCls",
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "field", className: "newCls", fieldName: "aaa" },
                oldObf: "oldCls.emjv",
            });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "field", className: "newCls", fieldName: "aaa" })).toBe("playerId");
        const m = session.migrations()!;
        expect(m.result.review).toHaveLength(0);
        expect(m.result.auto).toHaveLength(1);
    });

    it("accepts a method key", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "method", className: "newCls", methodName: "" },
                label: "encode",
                oldObf: "oldCls.vto",
                candidates: [{ newObf: "newCls.abc", score: 0.95, reason: "..." }],
                parentClassMigration: "oldCls",
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "method", className: "newCls", methodName: "abc" },
                oldObf: "oldCls.vto",
            });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "method", className: "newCls", methodName: "abc" })).toBe("encode");
    });

    it("backward-compat: oldObf+newObf payload still accepted (assumed class)", async () => {
        const session = makeFakeSessionPoly([
            {
                key: { kind: "class", className: "ecu" },
                label: "OldClass",
                oldObf: "ecu",
                candidates: [{ newObf: "egq", score: 0.92, reason: "..." }],
            },
        ]);
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({ oldObf: "ecu", newObf: "egq" });
        expect(res.status).toBe(200);
        expect(session.labelStore.get({ kind: "class", className: "egq" })).toBe("OldClass");
    });
});

describe("migrations routes — accept class triggers pass 2", () => {
    function makeFakeSessionWithPass2() {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-pass2-"));
        const labelStore = new LabelStore(path.join(tmpDir, "labels.json"));
        const profile: any = { labels: labelStore };
        const review = [
            {
                key: { kind: "class", className: "fzc" },
                label: "Encoder",
                oldObf: "fzc",
                candidates: [{ newObf: "abc", score: 0.92, reason: "..." }],
            },
        ];
        const migrations = { result: { auto: [], review, lost: [] } };
        const pass2Calls: any[] = [];
        return {
            profile: () => profile,
            migrations: () => migrations,
            labelStore,
            applyClassPass2: (oldObf: string, newObf: string) => {
                pass2Calls.push({ oldObf, newObf });
                const inserted = {
                    auto: [
                        {
                            key: { kind: "field", className: newObf, fieldName: "p" },
                            label: "playerId",
                            oldObf: "fzc.emjv",
                            newObf: `${newObf}.p`,
                            reason: "type+ordinal",
                            parentClassMigration: oldObf,
                        },
                    ],
                    review: [],
                    lost: [],
                };
                migrations.result.auto.push(...inserted.auto);
                return inserted;
            },
            pass2Calls,
        };
    }

    it("accept class triggers applyClassPass2 with old+new obf", async () => {
        const session = makeFakeSessionWithPass2();
        const local = express();
        local.use(express.json());
        mountMigrations(local, { session: session as any });

        const res = await request(local)
            .post("/api/migrations/accept")
            .send({
                key: { kind: "class", className: "abc" },
                oldObf: "fzc",
            });
        expect(res.status).toBe(200);
        expect(session.pass2Calls).toEqual([{ oldObf: "fzc", newObf: "abc" }]);
        expect(res.body.pass2.auto).toHaveLength(1);
    });
});
