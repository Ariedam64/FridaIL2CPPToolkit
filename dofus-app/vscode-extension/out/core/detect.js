"use strict";
// Build-version detection cascade for the active process.
// Tries 4 mechanisms in order; returns on the first success.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectBuildId = detectBuildId;
const crypto = __importStar(require("crypto"));
const HEX_PREFIX_LEN = 32;
async function detectBuildId(rpc) {
    // 1. Unity boot.config build-guid
    try {
        const dataPath = await rpc.call("getDataPath", []);
        if (dataPath) {
            const bootConfig = await rpc.call("readFile", [`${dataPath}/boot.config`]);
            const m = /build-guid=([0-9a-f]+)/i.exec(bootConfig);
            if (m) {
                return { buildId: m[1], source: "unity-boot-config" };
            }
        }
    }
    catch {
        // continue
    }
    // 2. global-metadata.dat hash
    try {
        const dataPath = await rpc.call("getDataPath", []);
        if (dataPath) {
            const hex = await rpc.call("readFileBytes", [
                `${dataPath}/il2cpp_data/Metadata/global-metadata.dat`,
            ]);
            const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
            return { buildId, source: "metadata-hash" };
        }
    }
    catch {
        // continue
    }
    // 3. Main binary hash
    try {
        const hex = await rpc.call("readMainModuleBytes", []);
        const buildId = sha256Hex(hex).slice(0, HEX_PREFIX_LEN);
        return { buildId, source: "binary-hash" };
    }
    catch {
        // continue
    }
    // 4. Timestamp fallback
    return { buildId: `unknown-${Date.now()}`, source: "timestamp" };
}
function sha256Hex(hexInput) {
    const buf = Buffer.from(hexInput, "hex");
    return crypto.createHash("sha256").update(buf).digest("hex");
}
//# sourceMappingURL=detect.js.map