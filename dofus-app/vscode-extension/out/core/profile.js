"use strict";
// ProfileManager: load / create / list profiles on disk.
// A profile lives at <profilesRoot>/<gameName>/<buildId>/ with these files:
//   - manifest.json
//   - labels.json
//   - annotations.json
//   - migrations.json (optional, written by migration engine)
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
exports.ProfileManager = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const labels_1 = require("./labels");
const annotations_1 = require("./annotations");
class ProfileManager {
    profilesRoot;
    onCorruption;
    constructor(profilesRoot, onCorruption) {
        this.profilesRoot = profilesRoot;
        this.onCorruption = onCorruption;
    }
    async createProfile(input) {
        const dir = path.join(this.profilesRoot, input.gameName, input.buildId);
        await fs.promises.mkdir(dir, { recursive: true });
        const now = new Date().toISOString();
        const manifest = {
            schemaVersion: 1,
            profileId: `${input.gameName}/${input.buildId}`,
            gameName: input.gameName,
            buildId: input.buildId,
            buildIdSource: input.buildIdSource,
            attachedFirstAt: now,
            attachedLastAt: now,
            derivedFrom: input.derivedFromBuildId
                ? `${input.gameName}/${input.derivedFromBuildId}`
                : null,
            stats: { totalLabels: 0, totalBookmarks: 0, totalNotes: 0 },
        };
        await fs.promises.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
        return {
            manifest,
            labels: new labels_1.LabelStore(path.join(dir, "labels.json"), this.onCorruption),
            annotations: new annotations_1.AnnotationStore(path.join(dir, "annotations.json"), this.onCorruption),
            rootPath: dir,
        };
    }
    async loadProfile(gameName, buildId) {
        const dir = path.join(this.profilesRoot, gameName, buildId);
        const manifestPath = path.join(dir, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`profile not found: ${gameName}/${buildId}`);
        }
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8"));
        manifest.attachedLastAt = new Date().toISOString();
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
        return {
            manifest,
            labels: new labels_1.LabelStore(path.join(dir, "labels.json"), this.onCorruption),
            annotations: new annotations_1.AnnotationStore(path.join(dir, "annotations.json"), this.onCorruption),
            rootPath: dir,
        };
    }
    async listBuilds(gameName) {
        const gameDir = path.join(this.profilesRoot, gameName);
        if (!fs.existsSync(gameDir))
            return [];
        const entries = await fs.promises.readdir(gameDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }
    async findMostRecentBuild(gameName, currentBuildId) {
        const builds = await this.listBuilds(gameName);
        const others = builds.filter((b) => b !== currentBuildId);
        if (others.length === 0)
            return null;
        const stats = await Promise.all(others.map(async (b) => {
            const manifestPath = path.join(this.profilesRoot, gameName, b, "manifest.json");
            try {
                const s = await fs.promises.stat(manifestPath);
                return { build: b, mtime: s.mtimeMs };
            }
            catch {
                return { build: b, mtime: 0 };
            }
        }));
        stats.sort((a, b) => b.mtime - a.mtime);
        return stats[0].build;
    }
    async saveFingerprints(profile, fps) {
        const data = JSON.stringify({ schemaVersion: 1, fingerprints: fps });
        const fpPath = path.join(profile.rootPath, "fingerprints.json");
        const tmp = fpPath + ".tmp";
        await fs.promises.writeFile(tmp, data, "utf-8");
        await fs.promises.rename(tmp, fpPath);
    }
    async loadFingerprints(gameName, buildId) {
        const fpPath = path.join(this.profilesRoot, gameName, buildId, "fingerprints.json");
        if (!fs.existsSync(fpPath))
            return null;
        try {
            const data = JSON.parse(await fs.promises.readFile(fpPath, "utf-8"));
            return data.fingerprints ?? [];
        }
        catch {
            return null;
        }
    }
    /**
     * Recompute manifest stats from the in-memory stores and atomically rewrite
     * `<profile>/manifest.json`. Idempotent — safe to call after every change
     * and after debounced flushes.
     */
    async updateStats(profile) {
        const stats = {
            totalLabels: profile.labels.totalCount(),
            totalBookmarks: profile.annotations.bookmarkCount(),
            totalNotes: profile.annotations.noteCount(),
        };
        if (profile.manifest.stats.totalLabels === stats.totalLabels &&
            profile.manifest.stats.totalBookmarks === stats.totalBookmarks &&
            profile.manifest.stats.totalNotes === stats.totalNotes) {
            return;
        }
        profile.manifest.stats = stats;
        const manifestPath = path.join(profile.rootPath, "manifest.json");
        const tmp = manifestPath + ".tmp";
        await fs.promises.writeFile(tmp, JSON.stringify(profile.manifest, null, 2), "utf-8");
        await fs.promises.rename(tmp, manifestPath);
    }
    async loadProfileLabels(gameName, buildId) {
        const labelsPath = path.join(this.profilesRoot, gameName, buildId, "labels.json");
        if (!fs.existsSync(labelsPath))
            return {};
        try {
            const data = JSON.parse(await fs.promises.readFile(labelsPath, "utf-8"));
            const out = {};
            for (const [obf, entry] of Object.entries(data.classes ?? {})) {
                out[obf] = entry.label;
            }
            return out;
        }
        catch {
            return {};
        }
    }
}
exports.ProfileManager = ProfileManager;
//# sourceMappingURL=profile.js.map