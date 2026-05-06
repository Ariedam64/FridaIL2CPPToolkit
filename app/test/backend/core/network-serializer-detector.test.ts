import { describe, it, expect } from "vitest";
import { detectSerializers } from "../../../backend/core/network/serializer-detector";

interface ClassPresence {
    /** key = short name OR full name (`<ns>.<className>`) */
    [name: string]: { methods: string[] };
}

function mkRpc(classes: ClassPresence) {
    return {
        async call<T>(method: string, args: unknown[] = []): Promise<T> {
            if (method === "listClassMembers") {
                const name = String(args[0] ?? "");
                const c = classes[name];
                if (!c) return { methods: [], fields: [] } as unknown as T;
                return { methods: c.methods, fields: [] } as unknown as T;
            }
            return null as unknown as T;
        },
    };
}

describe("detectSerializers", () => {
    it("returns empty array when no known patterns are present", async () => {
        const out = await detectSerializers(mkRpc({}));
        expect(out).toEqual([]);
    });

    it("detects Google.Protobuf.MessageExtensions and proposes Send + Recv entries", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo", "MergeDelimitedFrom"],
            },
        }));
        expect(out).toHaveLength(2);
        const send = out.find((e) => e.direction === "send");
        const recv = out.find((e) => e.direction === "recv");
        expect(send?.className).toBe("MessageExtensions");
        expect(send?.ns).toBe("Google.Protobuf");
        expect(send?.methodName).toBe("WriteDelimitedTo");
        expect(send?.methodSignature).toBeTruthy();
        expect(recv?.methodName).toBe("MergeDelimitedFrom");
        expect(out.every((e) => e.source === "auto")).toBe(true);
        expect(out.every((e) => e.disabled === true)).toBe(true);
    });

    it("detects MessagePackSerializer when present", async () => {
        const out = await detectSerializers(mkRpc({
            "MessagePack.MessagePackSerializer": {
                methods: ["Serialize", "Deserialize"],
            },
        }));
        expect(out.some((e) => e.className === "MessagePackSerializer" && e.direction === "send")).toBe(true);
        expect(out.some((e) => e.className === "MessagePackSerializer" && e.direction === "recv")).toBe(true);
    });

    it("returns proposals from multiple patterns when several are present", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo", "MergeDelimitedFrom"],
            },
            "MessagePack.MessagePackSerializer": {
                methods: ["Serialize", "Deserialize"],
            },
        }));
        expect(out.length).toBeGreaterThanOrEqual(4);
    });

    it("skips a pattern when one of its methods is missing", async () => {
        const out = await detectSerializers(mkRpc({
            "Google.Protobuf.MessageExtensions": {
                methods: ["WriteDelimitedTo"],
            },
        }));
        expect(out).toEqual([]);
    });
});
