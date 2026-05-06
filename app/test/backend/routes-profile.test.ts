// app/test/backend/routes-profile.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

import { mountProfile } from "../../backend/routes/profile.js";

function makeFakeSession() {
    let prof: any = null;
    return {
        profile: () => prof,
        async attach(pid: number) {
            prof = { manifest: { profileId: `dofus/${pid}-build`, gameName: "dofus" }, rootPath: `/tmp/p-${pid}` };
            return prof;
        },
        async detach() { prof = null; },
        fridaClient: {
            async listProcesses() { return [{ pid: 1234, name: "Dofus.exe" }]; },
        },
    };
}

let app: express.Express;
let session: ReturnType<typeof makeFakeSession>;

beforeEach(() => {
    session = makeFakeSession();
    app = express();
    app.use(express.json());
    mountProfile(app, { session: session as any });
});

describe("profile routes", () => {
    it("GET /api/profile returns null before attach", async () => {
        const res = await request(app).get("/api/profile");
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ profile: null });
    });

    it("POST /api/profile/attach attaches and returns the profile", async () => {
        const res = await request(app).post("/api/profile/attach").send({ pid: 1234 });
        expect(res.status).toBe(200);
        expect(res.body.profile.manifest.profileId).toBe("dofus/1234-build");
    });

    it("GET /api/profile returns the profile after attach", async () => {
        await request(app).post("/api/profile/attach").send({ pid: 1234 });
        const res = await request(app).get("/api/profile");
        expect(res.body.profile.manifest.gameName).toBe("dofus");
    });

    it("POST /api/profile/detach clears the profile", async () => {
        await request(app).post("/api/profile/attach").send({ pid: 1234 });
        await request(app).post("/api/profile/detach");
        const res = await request(app).get("/api/profile");
        expect(res.body.profile).toBeNull();
    });

    it("GET /api/profile/processes returns the process list", async () => {
        const res = await request(app).get("/api/profile/processes");
        expect(res.status).toBe(200);
        expect(res.body.processes).toEqual([{ pid: 1234, name: "Dofus.exe" }]);
    });

    it("POST /api/profile/attach without pid returns 400", async () => {
        const res = await request(app).post("/api/profile/attach").send({});
        expect(res.status).toBe(400);
    });
});
