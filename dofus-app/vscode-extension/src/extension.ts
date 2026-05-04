// Frida IL2CPP Toolkit — extension activation entry point.
//
// Wires together: RPC, build-version detection, profile loading, label/
// annotation stores, status bar, tree views, commands, and (eventually)
// plugins. Migrations are computed on profile attach.

import * as vscode from "vscode";
import * as os from "os";
import * as path from "path";

import { HttpRpcClient } from "./core/rpc";
import { detectBuildId } from "./core/detect";
import { ProfileManager, type Profile } from "./core/profile";
import { StatusBarController } from "./core/status-bar";
import {
    BookmarksProvider,
    MigrationsProvider,
    ProcessExplorerProvider,
} from "./core/explorer";
import { UniversalSearch } from "./core/search";
import { registerCommands } from "./core/commands";
import { createCoreApi, type CoreApi } from "./core/api";
import { matchFingerprints } from "./core/migrations";
import type { ClassFingerprint } from "./core/types";

let coreApi: CoreApi | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const config = vscode.workspace.getConfiguration("fridaToolkit");
    const rpc = new HttpRpcClient({
        endpoint: config.get<string>("rpcEndpoint", "http://localhost:3001/api/call"),
    });

    const profilesRoot = config.get<string>("profileRoot", "")
        || path.join(os.homedir(), ".frida-toolkit", "profiles");
    const profileManager = new ProfileManager(profilesRoot);

    let currentProfile: Profile | null = null;
    const profileSource = { current: () => currentProfile };

    const profileEmitter = new vscode.EventEmitter<Profile>();
    const profileDetachEmitter = new vscode.EventEmitter<void>();

    coreApi = createCoreApi({
        profileEmitter,
        profileDetachEmitter,
        profileSource,
        rpc,
    });

    // Tree providers
    const explorerProvider = new ProcessExplorerProvider(rpc, profileSource);
    const bookmarksProvider = new BookmarksProvider(profileSource);
    const migrationsProvider = new MigrationsProvider();

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider("fridaProcessExplorer", explorerProvider),
        vscode.window.registerTreeDataProvider("fridaBookmarks", bookmarksProvider),
        vscode.window.registerTreeDataProvider("fridaMigrations", migrationsProvider),
    );

    // Universal search
    const search = new UniversalSearch(rpc, profileSource);

    // Status bar
    const statusBar = new StatusBarController(rpc, profileSource, "frida.refresh");
    context.subscriptions.push(statusBar);
    statusBar.start();

    const refreshAll = (): void => {
        explorerProvider.refresh();
        bookmarksProvider.refresh();
        migrationsProvider.refresh();
        search.invalidate();
        statusBar.tick();
    };

    // Commands
    context.subscriptions.push(...registerCommands({
        rpc,
        profileSource,
        refresh: refreshAll,
        onShowObfNamesToggled: (show) => {
            explorerProvider.setShowObfNames(show);
            search.invalidate();
        },
        showSearch: () => search.show(),
    }));

    // Initial profile detection (fire-and-forget; UI degrades gracefully if RPC down)
    void (async () => {
        try {
            const healthy = await rpc.isHealthy();
            if (!healthy) return;

            const detected = await detectBuildId(rpc);
            const gameNameOverride = config.get<string>("gameNameOverride", "");
            const gameName = gameNameOverride || (await deriveGameName(rpc));

            // Try load existing
            try {
                currentProfile = await profileManager.loadProfile(gameName, detected.buildId);
            } catch {
                // Need to create — try deriving from a previous build
                const previous = await profileManager.findMostRecentBuild(gameName, detected.buildId);
                currentProfile = await profileManager.createProfile({
                    gameName,
                    buildId: detected.buildId,
                    buildIdSource: detected.source,
                    derivedFromBuildId: previous ?? undefined,
                });
            }

            // Fetch current fingerprints from the attached process
            let currentFps: ClassFingerprint[] = [];
            try {
                currentFps = await rpc.call<ClassFingerprint[]>("listClassFingerprints");
            } catch (e) {
                console.warn("listClassFingerprints failed:", e);
            }

            // If we just created a NEW profile derived from a previous build, run migration
            const wasNewlyCreated = currentProfile.manifest.derivedFrom !== null
                && currentProfile.manifest.attachedFirstAt === currentProfile.manifest.attachedLastAt;
            if (wasNewlyCreated && currentProfile.manifest.derivedFrom) {
                const previousBuildId = currentProfile.manifest.derivedFrom.split("/")[1];
                const oldFps = await profileManager.loadFingerprints(gameName, previousBuildId);
                if (oldFps && currentFps.length > 0) {
                    const oldLabels = await profileManager.loadProfileLabels(gameName, previousBuildId);
                    const result = matchFingerprints({ oldFps, newFps: currentFps, oldLabels });

                    // Apply auto-migrated labels to current profile
                    for (const m of result.auto) {
                        currentProfile.labels.set({ kind: "class", className: m.newObf }, m.label);
                    }
                    await currentProfile.labels.flush();

                    migrationsProvider.setMigrations(result);
                    vscode.window.showInformationMessage(
                        `Migrations: ${result.auto.length} auto-migrated, ${result.review.length} to review, ${result.lost.length} lost. See Migrations panel.`,
                    );
                } else if (!oldFps) {
                    vscode.window.showInformationMessage(
                        `New build detected. No stored fingerprints for ${previousBuildId} — migrations will be available after next attach.`,
                    );
                }
            }

            // Always save current fingerprints for the next attach to compare against
            if (currentFps.length > 0) {
                try {
                    await profileManager.saveFingerprints(currentProfile, currentFps);
                } catch (e) {
                    console.warn("saveFingerprints failed:", e);
                }
            }

            await vscode.commands.executeCommand("setContext", "fridaToolkit.connected", true);
            profileEmitter.fire(currentProfile);
            refreshAll();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida toolkit init failed: ${msg}`);
        }
    })();
}

async function deriveGameName(rpc: HttpRpcClient): Promise<string> {
    try {
        const dataPath = await rpc.call<string>("getDataPath");
        if (!dataPath) return "unknown-process";
        // Strip trailing _Data segment; e.g. "F:/Jeux/Dofus-dofus3/Dofus_Data" → "Dofus"
        const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
        return seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
    } catch {
        return "unknown-process";
    }
}

export function deactivate() {
    coreApi = undefined;
}

/** Plugins import this to obtain CoreApi. */
export function getCoreApi(): CoreApi | undefined {
    return coreApi;
}
