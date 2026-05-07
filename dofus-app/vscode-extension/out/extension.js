"use strict";
// Frida IL2CPP Toolkit — extension activation entry point.
//
// Wires together: RPC, build-version detection, profile loading, label/
// annotation stores, status bar, tree views, commands, and (eventually)
// plugins. Migrations are computed on profile attach.
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
exports.activate = activate;
exports.deactivate = deactivate;
exports.getCoreApi = getCoreApi;
const vscode = __importStar(require("vscode"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const rpc_1 = require("./core/rpc");
const detect_1 = require("./core/detect");
const paths_1 = require("./core/paths");
const profile_1 = require("./core/profile");
const status_bar_1 = require("./core/status-bar");
const explorer_1 = require("./core/explorer");
const search_1 = require("./core/search");
const commands_1 = require("./core/commands");
const api_1 = require("./core/api");
const hooks_1 = require("./plugins/hooks");
const migrations_1 = require("./core/migrations");
const frida_direct_1 = require("./core/frida-direct");
const process_explorer_1 = require("./core/webviews/process-explorer");
let coreApi;
let activeProfileForShutdown;
async function activate(context) {
    const config = vscode.workspace.getConfiguration("fridaToolkit");
    const useDirect = config.get("useDirectMode", true);
    let rpc;
    let fridaDirect;
    if (useDirect) {
        const agentScriptPath = config.get("agentScriptPath", "")
            || (0, frida_direct_1.resolveDefaultAgentPath)(context.extension);
        fridaDirect = new frida_direct_1.FridaDirectClient(agentScriptPath);
        rpc = fridaDirect;
    }
    else {
        rpc = new rpc_1.HttpRpcClient({
            endpoint: config.get("rpcEndpoint", "http://localhost:3001/api/call"),
        });
    }
    const profilesRoot = (0, paths_1.expandHome)(config.get("profileRoot", ""))
        || path.join(os.homedir(), ".frida-toolkit", "profiles");
    const profileManager = new profile_1.ProfileManager(profilesRoot);
    let currentProfile = null;
    const profileSource = { current: () => currentProfile };
    activeProfileForShutdown = profileSource;
    const profileEmitter = new vscode.EventEmitter();
    const profileDetachEmitter = new vscode.EventEmitter();
    const onAgentMessage = fridaDirect
        ? fridaDirect.onMessage
        : new vscode.EventEmitter().event;
    coreApi = (0, api_1.createCoreApi)({
        profileEmitter,
        profileDetachEmitter,
        profileSource,
        rpc,
        onAgentMessage,
    });
    context.subscriptions.push((0, hooks_1.activateHooksPlugin)(coreApi, context));
    // Tree providers (ProcessExplorerProvider replaced by webview)
    const bookmarksProvider = new explorer_1.BookmarksProvider(profileSource);
    const migrationsProvider = new explorer_1.MigrationsProvider();
    context.subscriptions.push(vscode.window.registerTreeDataProvider("fridaBookmarks", bookmarksProvider), vscode.window.registerTreeDataProvider("fridaMigrations", migrationsProvider));
    // Process Explorer webview panel
    const processExplorerPanel = new process_explorer_1.ProcessExplorerPanel(rpc, profileSource, { onAttach: profileEmitter });
    context.subscriptions.push({ dispose: () => processExplorerPanel.dispose() });
    context.subscriptions.push(vscode.commands.registerCommand("frida.openProcessExplorer", () => processExplorerPanel.show()));
    // Universal search
    const search = new search_1.UniversalSearch(rpc, profileSource);
    const refreshAll = () => {
        bookmarksProvider.refresh();
        migrationsProvider.refresh();
        search.invalidate();
        statusBar.tick();
    };
    // Status bar — refresh button calls frida.refresh which triggers initSession
    const statusBar = new status_bar_1.StatusBarController(rpc, profileSource, "frida.refresh");
    context.subscriptions.push(statusBar);
    statusBar.start();
    // Init session: detect build, load/create profile, run migrations, save fingerprints.
    // Idempotent — if a profile is already loaded, just refresh the UI.
    let initInFlight = false;
    const initSession = async (notify = false) => {
        if (initInFlight)
            return currentProfile !== null;
        initInFlight = true;
        try {
            const healthy = await rpc.isHealthy();
            if (!healthy) {
                if (notify) {
                    vscode.window.showWarningMessage("Frida RPC unreachable. Check the agent is running on the configured endpoint.");
                }
                return false;
            }
            const detected = await (0, detect_1.detectBuildId)(rpc);
            const gameNameOverride = config.get("gameNameOverride", "");
            const gameName = gameNameOverride || (await deriveGameName(rpc));
            try {
                currentProfile = await profileManager.loadProfile(gameName, detected.buildId);
            }
            catch {
                const previous = await profileManager.findMostRecentBuild(gameName, detected.buildId);
                currentProfile = await profileManager.createProfile({
                    gameName,
                    buildId: detected.buildId,
                    buildIdSource: detected.source,
                    derivedFromBuildId: previous ?? undefined,
                });
            }
            let currentFps = [];
            try {
                currentFps = await rpc.call("listClassFingerprints");
            }
            catch (e) {
                console.warn("listClassFingerprints failed:", e);
            }
            const wasNewlyCreated = currentProfile.manifest.derivedFrom !== null
                && currentProfile.manifest.attachedFirstAt === currentProfile.manifest.attachedLastAt;
            if (wasNewlyCreated && currentProfile.manifest.derivedFrom) {
                const previousBuildId = currentProfile.manifest.derivedFrom.split("/")[1];
                const oldFps = await profileManager.loadFingerprints(gameName, previousBuildId);
                if (oldFps && currentFps.length > 0) {
                    const oldLabels = await profileManager.loadProfileLabels(gameName, previousBuildId);
                    const result = (0, migrations_1.matchFingerprints)({ oldFps, newFps: currentFps, oldLabels });
                    for (const m of result.auto) {
                        currentProfile.labels.set({ kind: "class", className: m.newObf }, m.label);
                    }
                    await currentProfile.labels.flush();
                    migrationsProvider.setMigrations(result, { old: oldFps, current: currentFps });
                    vscode.window.showInformationMessage(`Migrations: ${result.auto.length} auto-migrated, ${result.review.length} to review, ${result.lost.length} lost. See Migrations panel.`);
                }
                else if (!oldFps) {
                    vscode.window.showInformationMessage(`New build detected. No stored fingerprints for ${previousBuildId} — migrations will be available after next attach.`);
                }
            }
            if (currentFps.length > 0) {
                try {
                    await profileManager.saveFingerprints(currentProfile, currentFps);
                }
                catch (e) {
                    console.warn("saveFingerprints failed:", e);
                }
            }
            // Subscribe to label/annotation changes for this profile so
            // manifest.stats stays in sync. Debounced to avoid I/O storms.
            const profileForListener = currentProfile;
            let statsTimer = null;
            const scheduleStatsUpdate = () => {
                if (statsTimer)
                    clearTimeout(statsTimer);
                statsTimer = setTimeout(() => {
                    statsTimer = null;
                    void profileManager.updateStats(profileForListener).catch((e) => {
                        console.warn("updateStats failed:", e);
                    });
                }, 600);
            };
            profileForListener.labels.onChange(scheduleStatsUpdate);
            profileForListener.annotations.onChange(scheduleStatsUpdate);
            // Also flush stats once at attach so the manifest reflects whatever
            // labels were already on disk (e.g. just-migrated entries).
            await profileManager.updateStats(profileForListener).catch((e) => {
                console.warn("initial updateStats failed:", e);
            });
            // Pre-warm the Process Explorer index off the user's first click.
            try {
                const r = await rpc.call("prewarmExplorerIndex");
                console.log(`[toolkit] explorer index prewarmed: ${r.assemblies} asm / ${r.classes} classes`);
            }
            catch (e) {
                console.warn("prewarmExplorerIndex failed:", e);
            }
            await vscode.commands.executeCommand("setContext", "fridaToolkit.connected", true);
            profileEmitter.fire(currentProfile);
            refreshAll();
            processExplorerPanel.show();
            if (notify) {
                vscode.window.showInformationMessage(`Connected: ${currentProfile.manifest.gameName} / ${currentProfile.manifest.buildId.slice(0, 8)}`);
            }
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (notify) {
                vscode.window.showWarningMessage(`Frida toolkit init failed: ${msg}`);
            }
            else {
                console.warn("Frida toolkit init failed:", msg);
            }
            return false;
        }
        finally {
            initInFlight = false;
        }
    };
    // Commands — refresh both reloads trees AND retries init when no profile yet
    context.subscriptions.push(...(0, commands_1.registerCommands)({
        rpc,
        profileSource,
        refresh: () => {
            refreshAll();
            if (!currentProfile) {
                void initSession(true);
            }
        },
        onShowObfNamesToggled: (_show) => {
            search.invalidate();
        },
        showSearch: () => search.show(),
        migrationsProvider,
        fridaDirect,
        onAttachedReinit: async () => {
            currentProfile = null;
            await initSession(true);
        },
        onDetach: () => {
            currentProfile = null;
            profileDetachEmitter.fire();
            void vscode.commands.executeCommand("setContext", "fridaToolkit.connected", false);
            refreshAll();
        },
    }));
    if (useDirect) {
        // Direct mode: do not auto-attach. The user picks a target via
        // "Frida: Attach to process..." command. Until then, status bar
        // shows "not connected".
        vscode.window.showInformationMessage("Frida direct mode. Use \"Frida: Attach to process...\" to begin.");
    }
    else {
        // HTTP mode: agent server is supposed to be running already.
        // Retry init every 2s for up to 30s.
        void (async () => {
            for (let i = 0; i < 15; i++) {
                const ok = await initSession(false);
                if (ok)
                    return;
                await new Promise((r) => setTimeout(r, 2000));
            }
            vscode.window.showWarningMessage("Frida RPC unreachable after 30s. Use Frida: Refresh once the agent is up.");
        })();
    }
}
async function deriveGameName(rpc) {
    try {
        const dataPath = await rpc.call("getDataPath");
        if (!dataPath)
            return "unknown-process";
        // Strip trailing _Data segment; e.g. "F:/Jeux/Dofus-dofus3/Dofus_Data" → "Dofus"
        const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
        return seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
    }
    catch {
        return "unknown-process";
    }
}
async function deactivate() {
    // Drain any pending debounced writes so we don't lose unsaved labels/notes.
    const profile = activeProfileForShutdown?.current();
    if (profile) {
        try {
            await profile.labels.flush();
        }
        catch (e) {
            console.warn("labels flush on deactivate failed:", e);
        }
        try {
            await profile.annotations.flush();
        }
        catch (e) {
            console.warn("annotations flush on deactivate failed:", e);
        }
    }
    activeProfileForShutdown = undefined;
    coreApi = undefined;
}
/** Plugins import this to obtain CoreApi. */
function getCoreApi() {
    return coreApi;
}
//# sourceMappingURL=extension.js.map