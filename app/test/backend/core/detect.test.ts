import { describe, it, expect } from "vitest";

import { detectBuildId } from "../../../backend/core/detect";
import type { RpcClient } from "../../../backend/core/types";

function mockRpc(impl: Partial<Record<string, (...args: unknown[]) => unknown>>): RpcClient {
    return {
        call: async <T>(method: string, args: unknown[] = []): Promise<T> => {
            const fn = impl[method];
            if (!fn) throw new Error(`mock: no handler for ${method}`);
            return fn(...args) as T;
        },
        isHealthy: async () => true,
    };
}

describe("detectBuildId", () => {
    it("uses unity boot.config build-guid when available", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: (path: unknown) => {
                expect(path).toBe("F:/Jeux/Game/Game_Data/boot.config");
                return "gfx-threading-mode=6\nbuild-guid=abc123def456\nhdr=0\n";
            },
        });

        const result = await detectBuildId(rpc);

        expect(result.buildId).toBe("abc123def456");
        expect(result.source).toBe("unity-boot-config");
    });

    it("falls back to metadata hash when boot.config missing build-guid", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: () => "gfx-threading-mode=6\nhdr=0\n",  // no build-guid
            readFileBytes: () => "deadbeef".repeat(8),         // 32-char hex
        });

        const result = await detectBuildId(rpc);

        expect(result.buildId.length).toBeGreaterThanOrEqual(16);
        expect(result.source).toBe("metadata-hash");
    });

    it("falls back to binary hash when metadata read fails", async () => {
        const rpc = mockRpc({
            getDataPath: () => "F:/Jeux/Game/Game_Data",
            readFile: () => "no build-guid here",
            readFileBytes: () => { throw new Error("not found"); },
            readMainModuleBytes: () => "cafebabe".repeat(16),  // 128 chars
        });

        const result = await detectBuildId(rpc);

        expect(result.source).toBe("binary-hash");
    });

    it("falls back to timestamp when everything fails", async () => {
        const rpc = mockRpc({
            getDataPath: () => { throw new Error("not unity"); },
            readMainModuleBytes: () => { throw new Error("module unreachable"); },
        });

        const result = await detectBuildId(rpc);

        expect(result.source).toBe("timestamp");
        expect(result.buildId).toMatch(/^unknown-\d+$/);
    });
});
