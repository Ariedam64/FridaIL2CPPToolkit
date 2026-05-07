"use strict";
// Disk-backed storage for plugins. Lives at
// `<profile>/plugins/<pluginId>/storage.json`.
//
// Kept vscode-free so it can be unit-tested with vitest.
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
exports.DiskPluginStorage = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class DiskPluginStorage {
    cache = null;
    filePath;
    constructor(profileRoot, pluginId) {
        const safePluginId = pluginId.replace(/[^A-Za-z0-9_.-]/g, "_");
        this.filePath = path.join(profileRoot, "plugins", safePluginId, "storage.json");
    }
    get(key) {
        const data = this.load();
        return data.get(key) ?? null;
    }
    set(key, value) {
        const data = this.load();
        data.set(key, value);
        this.persist();
    }
    delete(key) {
        const data = this.load();
        if (!data.delete(key))
            return;
        this.persist();
    }
    list() {
        return Array.from(this.load().keys());
    }
    load() {
        if (this.cache)
            return this.cache;
        this.cache = new Map();
        if (!fs.existsSync(this.filePath))
            return this.cache;
        try {
            const raw = fs.readFileSync(this.filePath, "utf-8");
            const obj = JSON.parse(raw);
            for (const [k, v] of Object.entries(obj)) {
                this.cache.set(k, v);
            }
        }
        catch {
            // Corrupt JSON — start fresh; the next persist() overwrites it.
        }
        return this.cache;
    }
    persist() {
        if (!this.cache)
            return;
        const obj = {};
        for (const [k, v] of this.cache)
            obj[k] = v;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = this.filePath + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
        fs.renameSync(tmp, this.filePath);
    }
}
exports.DiskPluginStorage = DiskPluginStorage;
//# sourceMappingURL=plugin-storage.js.map