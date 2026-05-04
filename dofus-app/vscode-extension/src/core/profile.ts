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
import type { BuildIdSource, ProfileManifest } from "./types";

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
}
