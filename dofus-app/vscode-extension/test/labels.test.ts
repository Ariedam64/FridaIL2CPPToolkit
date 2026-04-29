import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { LabelStore } from "../src/core/labels";
import type { LabelKey } from "../src/core/types";

let tmpDir: string;
let labelsPath: string;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "labels-test-"));
    labelsPath = path.join(tmpDir, "labels.json");
});

const classKey = (className: string): LabelKey => ({ kind: "class", className });
const methodKey = (className: string, methodName: string): LabelKey => ({ kind: "method", className, methodName });
const fieldKey = (className: string, fieldName: string): LabelKey => ({ kind: "field", className, fieldName });

describe("LabelStore", () => {
    it("returns null for unset labels", () => {
        const store = new LabelStore(labelsPath);
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("stores and retrieves a class label", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        expect(store.get(classKey("egq"))).toBe("HaapiService");
    });

    it("stores method and field labels independently", () => {
        const store = new LabelStore(labelsPath);
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        store.set(fieldKey("egq", "dwm"), "_kardCache");
        expect(store.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
        expect(store.get(fieldKey("egq", "dwm"))).toBe("_kardCache");
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("removes a label", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.remove(classKey("egq"));
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("emits change events with old and new values", () => {
        const store = new LabelStore(labelsPath);
        const events: Array<{ old: string | null; next: string | null }> = [];
        store.onChange((e) => events.push({ old: e.oldLabel, next: e.newLabel }));
        store.set(classKey("egq"), "HaapiService");
        store.set(classKey("egq"), "HaapiClient");
        store.remove(classKey("egq"));
        expect(events).toEqual([
            { old: null, next: "HaapiService" },
            { old: "HaapiService", next: "HaapiClient" },
            { old: "HaapiClient", next: null },
        ]);
    });

    it("persists to disk and reloads", async () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        await store.flush();

        expect(fs.existsSync(labelsPath)).toBe(true);

        const reloaded = new LabelStore(labelsPath);
        expect(reloaded.get(classKey("egq"))).toBe("HaapiService");
        expect(reloaded.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
    });

    it("undo reverts the last change", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.undo();
        expect(store.get(classKey("egq"))).toBeNull();
    });

    it("redo replays an undone change", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.undo();
        store.redo();
        expect(store.get(classKey("egq"))).toBe("HaapiService");
    });

    it("display() returns label when set, obf otherwise", () => {
        const store = new LabelStore(labelsPath);
        expect(store.display(classKey("egq"))).toBe("egq");
        store.set(classKey("egq"), "HaapiService");
        expect(store.display(classKey("egq"))).toBe("HaapiService");
    });

    it("bulk import merges new labels", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("eat"), "MapView");
        const result = store.bulkImport({
            schemaVersion: 1,
            classes: { "egq": { label: "HaapiService", createdAt: "2026-04-30T00:00:00Z", updatedAt: "2026-04-30T00:00:00Z" } },
            methods: {},
            fields: {},
        });
        expect(result.imported).toBe(1);
        expect(store.get(classKey("egq"))).toBe("HaapiService");
        expect(store.get(classKey("eat"))).toBe("MapView");
    });

    it("bulk export round-trips", () => {
        const store = new LabelStore(labelsPath);
        store.set(classKey("egq"), "HaapiService");
        store.set(methodKey("egq", "ywp"), "ConsumeKardByCode");
        const exported = store.bulkExport();

        const reimport = new LabelStore(path.join(tmpDir, "other.json"));
        reimport.bulkImport(exported);
        expect(reimport.get(classKey("egq"))).toBe("HaapiService");
        expect(reimport.get(methodKey("egq", "ywp"))).toBe("ConsumeKardByCode");
    });
});
