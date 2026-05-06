// Build-version detection cascade for the active process.
// Tries 4 mechanisms in order; returns on the first success.

import * as crypto from "crypto";

import type { BuildIdResult, RpcClient } from "./types";

const HEX_PREFIX_LEN = 32;

export async function detectBuildId(rpc: RpcClient): Promise<BuildIdResult> {
    // 1. Unity boot.config build-guid
    try {
        const dataPath = await rpc.call<string>("getDataPath", []);
        if (dataPath) {
            const bootConfig = await rpc.call<string>("readFile", [`${dataPath}/boot.config`]);
            const m = /build-guid=([0-9a-f]+)/i.exec(bootConfig);
            if (m) {
                return { buildId: m[1], source: "unity-boot-config" };
            }
        }
    } catch {
        // continue
    }

    // 2. global-metadata.dat hash
    try {
        const dataPath = await rpc.call<string>("getDataPath", []);
        if (dataPath) {
            const hex = await rpc.call<string>("readFileBytes", [
                `${dataPath}/il2cpp_data/Metadata/global-metadata.dat`,
            ]);
            const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
            return { buildId, source: "metadata-hash" };
        }
    } catch {
        // continue
    }

    // 3. Main binary hash
    try {
        const hex = await rpc.call<string>("readMainModuleBytes", []);
        const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
        return { buildId, source: "binary-hash" };
    } catch {
        // continue
    }

    // 4. Timestamp fallback
    return { buildId: `unknown-${Date.now()}`, source: "timestamp" };
}

function sha256Hex(hexInput: string): string {
    const buf = Buffer.from(hexInput, "hex");
    return crypto.createHash("sha256").update(buf).digest("hex");
}
