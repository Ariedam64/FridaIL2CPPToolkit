import { describe, it, expect } from "vitest";
import { defineScript } from "../../../../backend/core/scripts/types";

describe("types — defineScript", () => {
    it("returns the definition unchanged (identity function)", () => {
        const def = defineScript({
            name: "noop",
            params: {},
            run: async () => "ok",
        });
        expect(def.name).toBe("noop");
        expect(typeof def.run).toBe("function");
    });

    it("infers param types in run signature", async () => {
        const def = defineScript({
            name: "echo",
            params: { msg: { type: "string", required: true } },
            run: async ({ msg }) => msg.toUpperCase(),
        });
        const fakeToolkit = {} as Parameters<typeof def.run>[1];
        expect(await def.run({ msg: "hi" }, fakeToolkit)).toBe("HI");
    });
});
