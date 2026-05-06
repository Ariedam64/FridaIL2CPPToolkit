import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { AnnotationStore } from "../../../backend/core/annotations";
import type { LabelKey } from "../../../backend/core/types";

let tmpDir: string;
let annPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ann-test-"));
    annPath = path.join(tmpDir, "annotations.json");
});

const classKey = (n: string): LabelKey => ({ kind: "class", className: n });
const methodKey = (c: string, m: string): LabelKey => ({ kind: "method", className: c, methodName: m });

describe("AnnotationStore — bookmarks", () => {
    it("toggles bookmark on/off", () => {
        const store = new AnnotationStore(annPath);
        const k = classKey("egq");
        expect(store.isBookmarked(k)).toBe(false);
        store.toggleBookmark(k);
        expect(store.isBookmarked(k)).toBe(true);
        store.toggleBookmark(k);
        expect(store.isBookmarked(k)).toBe(false);
    });

    it("lists all bookmarks", () => {
        const store = new AnnotationStore(annPath);
        store.toggleBookmark(classKey("egq"));
        store.toggleBookmark(methodKey("eat", "LoadMap"));
        const list = store.listBookmarks();
        expect(list).toHaveLength(2);
    });

    it("persists bookmarks", async () => {
        const store = new AnnotationStore(annPath);
        store.toggleBookmark(classKey("egq"));
        await store.flush();

        const reloaded = new AnnotationStore(annPath);
        expect(reloaded.isBookmarked(classKey("egq"))).toBe(true);
    });
});

describe("AnnotationStore — notes", () => {
    it("returns null for missing notes", () => {
        const store = new AnnotationStore(annPath);
        expect(store.getNote(classKey("egq"))).toBeNull();
    });

    it("stores and retrieves a note", () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "Service principal HAAPI...");
        expect(store.getNote(classKey("egq"))).toBe("Service principal HAAPI...");
    });

    it("removes a note", () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "...");
        store.removeNote(classKey("egq"));
        expect(store.getNote(classKey("egq"))).toBeNull();
    });

    it("persists notes", async () => {
        const store = new AnnotationStore(annPath);
        store.setNote(classKey("egq"), "test note");
        await store.flush();
        const reloaded = new AnnotationStore(annPath);
        expect(reloaded.getNote(classKey("egq"))).toBe("test note");
    });
});

describe("AnnotationStore — events", () => {
    it("fires events on bookmark add/remove", () => {
        const store = new AnnotationStore(annPath);
        const events: string[] = [];
        store.onChange((e) => events.push(`${e.kind}:${e.action}`));
        store.toggleBookmark(classKey("egq"));
        store.toggleBookmark(classKey("egq"));
        expect(events).toEqual(["bookmark:added", "bookmark:removed"]);
    });

    it("fires events on note set/update/remove", () => {
        const store = new AnnotationStore(annPath);
        const events: string[] = [];
        store.onChange((e) => events.push(`${e.kind}:${e.action}`));
        store.setNote(classKey("egq"), "first");
        store.setNote(classKey("egq"), "second");
        store.removeNote(classKey("egq"));
        expect(events).toEqual(["note:added", "note:updated", "note:removed"]);
    });
});

describe("AnnotationStore — corruption", () => {
    it("backs up a corrupted JSON file and starts fresh", () => {
        fs.writeFileSync(annPath, "broken json {", "utf-8");
        const backups: string[] = [];
        const store = new AnnotationStore(annPath, (b) => backups.push(b));

        expect(fs.existsSync(annPath)).toBe(false);
        expect(backups).toHaveLength(1);
        expect(fs.existsSync(backups[0])).toBe(true);

        expect(store.isBookmarked(classKey("egq"))).toBe(false);
        store.toggleBookmark(classKey("egq"));
        expect(store.isBookmarked(classKey("egq"))).toBe(true);
    });
});
