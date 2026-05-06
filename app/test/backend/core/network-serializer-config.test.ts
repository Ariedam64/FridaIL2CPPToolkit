import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DiskPluginStorage } from "../../../backend/core/plugin-storage";
import { SerializerConfigStore } from "../../../backend/core/network/serializer-config";
import type { SerializerEntry } from "../../../backend/core/network/types";

let tmp: string;
let store: SerializerConfigStore;

const ENTRY_A: SerializerEntry = {
    source: "manual",
    direction: "send",
    className: "ecu",
    ns: "Game.Net",
    methodName: "xbe",
    methodSignature: "(Google.Protobuf.IMessage):System.Void",
    paramIndex: 0,
    addedAt: "2026-05-06T10:00:00.000Z",
};

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "net-cfg-"));
    store = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
});

describe("SerializerConfigStore", () => {
    it("returns empty config when storage is empty", () => {
        const cfg = store.get();
        expect(cfg.schemaVersion).toBe(1);
        expect(cfg.entries).toEqual([]);
    });

    it("adds an entry and persists it across reloads", () => {
        store.add(ENTRY_A);
        const reloaded = new SerializerConfigStore(new DiskPluginStorage(tmp, "network"));
        const cfg = reloaded.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].className).toBe("ecu");
    });

    it("removes an entry by className+methodName+direction triple", () => {
        store.add(ENTRY_A);
        store.add({ ...ENTRY_A, methodName: "ybe" });
        store.remove({ className: "ecu", methodName: "xbe", direction: "send" });
        const cfg = store.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].methodName).toBe("ybe");
    });

    it("replace replaces all entries", () => {
        store.add(ENTRY_A);
        store.replace([{ ...ENTRY_A, source: "auto", className: "abc" }]);
        const cfg = store.get();
        expect(cfg.entries).toHaveLength(1);
        expect(cfg.entries[0].className).toBe("abc");
    });

    it("setDisabled toggles disabled flag", () => {
        store.add(ENTRY_A);
        store.setDisabled({ className: "ecu", methodName: "xbe", direction: "send" }, true);
        expect(store.get().entries[0].disabled).toBe(true);
        store.setDisabled({ className: "ecu", methodName: "xbe", direction: "send" }, false);
        expect(store.get().entries[0].disabled).toBe(false);
    });

    it("markStale flips the stale flag", () => {
        store.add(ENTRY_A);
        store.markStale({ className: "ecu", methodName: "xbe", direction: "send" }, true);
        expect(store.get().entries[0].stale).toBe(true);
    });

    it("emits change events on mutations", () => {
        let n = 0;
        const off = store.onChange(() => n++);
        store.add(ENTRY_A);
        store.add({ ...ENTRY_A, methodName: "ybe" });
        store.remove({ className: "ecu", methodName: "xbe", direction: "send" });
        off();
        store.add({ ...ENTRY_A, methodName: "zbe" });
        expect(n).toBe(3);
    });

    it("upgrades unknown schema version by replacing with empty config", () => {
        const ps = new DiskPluginStorage(tmp, "network");
        ps.set("serializer-config", { schemaVersion: 99, entries: [{}] });
        const fresh = new SerializerConfigStore(ps);
        expect(fresh.get().entries).toEqual([]);
        expect(fresh.get().schemaVersion).toBe(1);
    });
});
