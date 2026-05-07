import { describe, it, expect, beforeEach } from "vitest";
import { InstanceRegistry } from "../../../../backend/core/instances/instance-registry";

describe("InstanceRegistry", () => {
    let reg: InstanceRegistry;
    beforeEach(() => { reg = new InstanceRegistry(); });

    it("set + get returns the entry", () => {
        reg.set("player", "PlayerCharacter", "0x5af", "captureViaGC");
        const got = reg.get("player");
        expect(got).not.toBeNull();
        expect(got!.className).toBe("PlayerCharacter");
        expect(got!.handle).toBe("0x5af");
        expect(got!.capturedVia).toBe("captureViaGC");
        expect(got!.isAlive).toBe(true);
    });

    it("set on existing key overwrites", () => {
        reg.set("player", "OldClass", "0x1", "captureViaGC");
        reg.set("player", "NewClass", "0x2", "captureViaHook");
        expect(reg.get("player")!.className).toBe("NewClass");
    });

    it("delete removes the entry", () => {
        reg.set("player", "PlayerCharacter", "0x5af", "captureViaGC");
        reg.delete("player");
        expect(reg.get("player")).toBeNull();
    });

    it("list returns all entries in insertion order", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.set("c", "C", "0x3", "captureViaGC");
        expect(reg.list().map((e) => e.key)).toEqual(["a", "b", "c"]);
    });

    it("clear empties the registry", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.clear();
        expect(reg.list()).toHaveLength(0);
    });

    it("onChange emits on set/delete/clear", () => {
        let count = 0;
        reg.onChange(() => { count++; });
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.delete("a");
        reg.set("b", "B", "0x2", "captureViaGC");
        reg.clear();
        expect(count).toBe(4);
    });

    it("setAlive(false) marks the entry as dead", () => {
        reg.set("a", "A", "0x1", "captureViaGC");
        reg.setAlive("a", false);
        expect(reg.get("a")!.isAlive).toBe(false);
    });
});
