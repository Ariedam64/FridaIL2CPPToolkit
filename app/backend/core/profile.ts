// ProfileManager: load / create / list profiles on disk.
// A profile lives at <profilesRoot>/<gameName>/<buildId>/ with these files:
//   - manifest.json
//   - labels.json
//   - annotations.json
//   - migrations.json (optional, written by migration engine)

import * as fs from "fs";
import * as path from "path";

import { LabelStore } from "./labels";
import { AnnotationStore } from "./annotations";
import type { BuildIdSource, ClassFingerprint, ProfileManifest } from "./types";

export interface CreateProfileInput {
    gameName: string;
    buildId: string;
    buildIdSource: BuildIdSource;
    /** Optional: records lineage in the manifest. Migration is the engine's job. */
    derivedFromBuildId?: string;
}

export interface Profile {
    manifest: ProfileManifest;
    labels: LabelStore;
    annotations: AnnotationStore;
    rootPath: string;
}

export class ProfileManager {
    constructor(
        private readonly profilesRoot: string,
        private readonly onCorruption?: (backupPath: string) => void,
    ) {}

    async createProfile(input: CreateProfileInput): Promise<Profile> {
        const dir = path.join(this.profilesRoot, input.gameName, input.buildId);
        await fs.promises.mkdir(dir, { recursive: true });

        const now = new Date().toISOString();
        const manifest: ProfileManifest = {
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
        await fs.promises.writeFile(
            path.join(dir, "manifest.json"),
            JSON.stringify(manifest, null, 2),
            "utf-8",
        );

        return {
            manifest,
            labels: new LabelStore(path.join(dir, "labels.json"), this.onCorruption),
            annotations: new AnnotationStore(path.join(dir, "annotations.json"), this.onCorruption),
            rootPath: dir,
        };
    }

    async loadProfile(gameName: string, buildId: string): Promise<Profile> {
        const dir = path.join(this.profilesRoot, gameName, buildId);
        const manifestPath = path.join(dir, "manifest.json");
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`profile not found: ${gameName}/${buildId}`);
        }
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf-8")) as ProfileManifest;
        manifest.attachedLastAt = new Date().toISOString();
        await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

        return {
            manifest,
            labels: new LabelStore(path.join(dir, "labels.json"), this.onCorruption),
            annotations: new AnnotationStore(path.join(dir, "annotations.json"), this.onCorruption),
            rootPath: dir,
        };
    }

    async listBuilds(gameName: string): Promise<string[]> {
        const gameDir = path.join(this.profilesRoot, gameName);
        if (!fs.existsSync(gameDir)) return [];
        const entries = await fs.promises.readdir(gameDir, { withFileTypes: true });
        return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    }

    async findMostRecentBuild(gameName: string, currentBuildId: string): Promise<string | null> {
        const builds = await this.listBuilds(gameName);
        const others = builds.filter((b) => b !== currentBuildId);
        if (others.length === 0) return null;
        const stats = await Promise.all(
            others.map(async (b) => {
                const manifestPath = path.join(this.profilesRoot, gameName, b, "manifest.json");
                try {
                    const s = await fs.promises.stat(manifestPath);
                    return { build: b, mtime: s.mtimeMs };
                } catch {
                    return { build: b, mtime: 0 };
                }
            }),
        );
        stats.sort((a, b) => b.mtime - a.mtime);
        return stats[0].build;
    }

    async saveFingerprints(profile: Profile, fps: ClassFingerprint[]): Promise<void> {
        const data = JSON.stringify({ schemaVersion: 1, fingerprints: fps });
        const fpPath = path.join(profile.rootPath, "fingerprints.json");
        const tmp = fpPath + ".tmp";
        await fs.promises.writeFile(tmp, data, "utf-8");
        await fs.promises.rename(tmp, fpPath);
    }

    async loadFingerprints(gameName: string, buildId: string): Promise<ClassFingerprint[] | null> {
        const fpPath = path.join(this.profilesRoot, gameName, buildId, "fingerprints.json");
        if (!fs.existsSync(fpPath)) return null;
        try {
            const data = JSON.parse(await fs.promises.readFile(fpPath, "utf-8")) as {
                schemaVersion: 1;
                fingerprints: ClassFingerprint[];
            };
            return data.fingerprints ?? [];
        } catch {
            return null;
        }
    }

    /**
     * Recompute manifest stats from the in-memory stores and atomically rewrite
     * `<profile>/manifest.json`. Idempotent — safe to call after every change
     * and after debounced flushes.
     */
    async updateStats(profile: Profile): Promise<void> {
        const stats = {
            totalLabels: profile.labels.totalCount(),
            totalBookmarks: profile.annotations.bookmarkCount(),
            totalNotes: profile.annotations.noteCount(),
        };
        if (
            profile.manifest.stats.totalLabels === stats.totalLabels &&
            profile.manifest.stats.totalBookmarks === stats.totalBookmarks &&
            profile.manifest.stats.totalNotes === stats.totalNotes
        ) {
            return;
        }
        profile.manifest.stats = stats;
        const manifestPath = path.join(profile.rootPath, "manifest.json");
        const tmp = manifestPath + ".tmp";
        await fs.promises.writeFile(tmp, JSON.stringify(profile.manifest, null, 2), "utf-8");
        await fs.promises.rename(tmp, manifestPath);
    }

    async loadProfileLabels(gameName: string, buildId: string): Promise<Record<string, string>> {
        const labelsPath = path.join(this.profilesRoot, gameName, buildId, "labels.json");
        if (!fs.existsSync(labelsPath)) return {};
        try {
            const data = JSON.parse(await fs.promises.readFile(labelsPath, "utf-8")) as {
                classes?: Record<string, { label: string }>;
            };
            const out: Record<string, string> = {};
            for (const [obf, entry] of Object.entries(data.classes ?? {})) {
                out[obf] = entry.label;
            }
            return out;
        } catch {
            return {};
        }
    }
}
