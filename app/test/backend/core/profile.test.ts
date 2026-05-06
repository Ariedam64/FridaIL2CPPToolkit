import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ProfileManager } from "../../../backend/core/profile";

let tmpRoot: string;

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "profile-test-"));
});

describe("ProfileManager", () => {
    it("creates a fresh profile when none exists", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const profile = await mgr.createProfile({
            gameName: "dofus",
            buildId: "abc123",
            buildIdSource: "unity-boot-config",
        });

        expect(profile.manifest.gameName).toBe("dofus");
        expect(profile.manifest.buildId).toBe("abc123");
        expect(profile.manifest.derivedFrom).toBeNull();
        expect(fs.existsSync(path.join(tmpRoot, "dofus", "abc123", "manifest.json"))).toBe(true);
    });

    it("loads an existing profile", async () => {
        const mgr = new ProfileManager(tmpRoot);
        await mgr.createProfile({
            gameName: "dofus",
            buildId: "abc123",
            buildIdSource: "unity-boot-config",
        });

        const loaded = await mgr.loadProfile("dofus", "abc123");

        expect(loaded.manifest.buildId).toBe("abc123");
    });

    it("lists previous builds for the same game", async () => {
        const mgr = new ProfileManager(tmpRoot);
        await mgr.createProfile({ gameName: "dofus", buildId: "old", buildIdSource: "binary-hash" });
        await mgr.createProfile({ gameName: "dofus", buildId: "new", buildIdSource: "binary-hash" });

        const builds = await mgr.listBuilds("dofus");

        expect(builds).toEqual(expect.arrayContaining(["old", "new"]));
    });

    it("derives a profile (copies labels from previous build)", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const old = await mgr.createProfile({ gameName: "dofus", buildId: "old", buildIdSource: "binary-hash" });
        old.labels.set({ kind: "class", className: "egq" }, "HaapiService");
        await old.labels.flush();

        const fresh = await mgr.createProfile({
            gameName: "dofus",
            buildId: "new",
            buildIdSource: "binary-hash",
            derivedFromBuildId: "old",
        });

        expect(fresh.manifest.derivedFrom).toBe("dofus/old");
        expect(fresh.labels.get({ kind: "class", className: "egq" })).toBeNull();
    });

    it("updateStats recomputes manifest counters and writes to disk", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const p = await mgr.createProfile({
            gameName: "dofus", buildId: "abc", buildIdSource: "binary-hash",
        });
        p.labels.set({ kind: "class", className: "egq" }, "HaapiService");
        p.labels.set({ kind: "method", className: "egq", methodName: "ywp" }, "Consume");
        p.annotations.toggleBookmark({ kind: "class", className: "egq" });
        p.annotations.setNote({ kind: "class", className: "egq" }, "important");

        await mgr.updateStats(p);

        // In-memory manifest reflects the new counts
        expect(p.manifest.stats).toEqual({ totalLabels: 2, totalBookmarks: 1, totalNotes: 1 });

        // On-disk manifest also updated
        const reloaded = await mgr.loadProfile("dofus", "abc");
        expect(reloaded.manifest.stats).toEqual({ totalLabels: 2, totalBookmarks: 1, totalNotes: 1 });
    });

    it("returns the most recent previous build (for derive)", async () => {
        const mgr = new ProfileManager(tmpRoot);
        const a = await mgr.createProfile({ gameName: "dofus", buildId: "a", buildIdSource: "binary-hash" });
        a.labels.set({ kind: "class", className: "x" }, "X");
        await a.labels.flush();
        await new Promise((r) => setTimeout(r, 10));
        const b = await mgr.createProfile({ gameName: "dofus", buildId: "b", buildIdSource: "binary-hash" });
        b.labels.set({ kind: "class", className: "y" }, "Y");
        await b.labels.flush();

        const previous = await mgr.findMostRecentBuild("dofus", "c");

        expect(previous).toBe("b");
    });
});
