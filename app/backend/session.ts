// app/backend/session.ts
//
// Process-wide singleton holding the current Frida session + profile
// + per-profile stores (labels, annotations, hooks). Routes import this
// to read/mutate state. Profile lifecycle: created on attach, replaced
// on re-attach to a different process/build, cleared on detach.

import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";

import { FridaClient } from "./frida-client.js";
import { ProfileManager, type Profile } from "./core/profile.js";
import { detectBuildId } from "./core/detect.js";
import { matchFingerprints, matchClassMembers } from "./core/migrations.js";
import { HookStore } from "./core/hooks/hook-store.js";
import { FrameStore } from "./core/network/frame-store.js";
import { SerializerConfigStore } from "./core/network/serializer-config.js";
import { RING_BUFFER_SIZE } from "./core/network/types.js";
import type { NetworkFrame } from "./core/network/types.js";
import { DiskPluginStorage } from "./core/plugin-storage.js";
import { expandHome } from "./core/paths.js";
import type { ClassFingerprint, MigrationResult } from "./core/types.js";
import { detectSerializers } from "./core/network/serializer-detector.js";
import { InstanceRegistry } from "./core/instances/instance-registry.js";
import { HistoryStore } from "./core/instances/history-store.js";
import { RecipeStore } from "./core/instances/recipe-store.js";
import { ScriptLoader } from "./core/scripts/script-loader.js";
import { ScriptRunner } from "./core/scripts/script-runner.js";
import { buildToolkit } from "./core/scripts/toolkit-api.js";
import { emitScriptsTypes } from "./core/scripts/types-emitter.js";

const PROFILE_ROOT =
    expandHome(process.env.FRIDA_TOOLKIT_PROFILE_ROOT ?? "") ||
    path.join(os.homedir(), ".frida-toolkit", "profiles");

export class Session extends EventEmitter {
    readonly fridaClient: FridaClient;
    readonly profileManager: ProfileManager;
    private currentProfile: Profile | null = null;
    private currentHookStore: HookStore | null = null;
    private currentFrameStore: FrameStore | null = null;
    private currentSerializerConfig: SerializerConfigStore | null = null;
    private currentMigrations: {
        result: MigrationResult;
        oldFps: ClassFingerprint[];
        currentFps: ClassFingerprint[];
        oldMethodLabels: Record<string, string>;
        oldFieldLabels: Record<string, string>;
    } | null = null;
    private currentInstanceRegistry: InstanceRegistry | null = null;
    private currentHistoryStore: HistoryStore | null = null;
    private currentRecipeStore: RecipeStore | null = null;
    private currentScanMatches: import("./core/instances/types.js").ScanMatch[] = [];
    private currentScriptLoader: ScriptLoader | null = null;
    private currentScriptRunner: ScriptRunner | null = null;
    private instancesReadOnly = true;
    private disposeListeners: Array<() => void> = [];
    private attachInFlight: Promise<Profile> | null = null;

    constructor(agentScriptPath: string) {
        super();
        this.fridaClient = new FridaClient(agentScriptPath);
        this.profileManager = new ProfileManager(PROFILE_ROOT);
        this.fridaClient.on("agent-message", (payload) => {
            this.emit("agent-message", payload);
            if (
                payload && typeof payload === "object" &&
                (payload as { type?: string }).type === "hook-event" &&
                this.currentHookStore
            ) {
                const p = payload as { type: string; hookId?: string; args?: unknown[]; ts?: number };
                if (p.hookId) {
                    this.currentHookStore.notifyAgentEvent(p.hookId, p.args ?? [], p.ts);
                }
            }
        });
        this.fridaClient.on("detached", () => this.handleDetach());
    }

    profile(): Profile | null {
        return this.currentProfile;
    }

    hookStore(): HookStore | null {
        return this.currentHookStore;
    }

    frameStore(): FrameStore | null {
        return this.currentFrameStore;
    }

    serializerConfigStore(): SerializerConfigStore | null {
        return this.currentSerializerConfig;
    }

    migrations(): { result: MigrationResult } | null {
        return this.currentMigrations ? { result: this.currentMigrations.result } : null;
    }

    instanceRegistry(): InstanceRegistry | null { return this.currentInstanceRegistry; }
    historyStore(): HistoryStore | null { return this.currentHistoryStore; }
    recipeStore(): RecipeStore | null { return this.currentRecipeStore; }
    scriptLoader(): ScriptLoader | null { return this.currentScriptLoader; }
    scriptRunner(): ScriptRunner | null { return this.currentScriptRunner; }
    getReadOnly(): boolean { return this.instancesReadOnly; }
    setReadOnly(v: boolean): void { this.instancesReadOnly = v; }

    getScanMatches(): import("./core/instances/types.js").ScanMatch[] {
        return this.currentScanMatches;
    }
    setScanMatches(matches: import("./core/instances/types.js").ScanMatch[]): void {
        this.currentScanMatches = matches;
    }

    async agentCall(method: string, args: unknown[]): Promise<unknown> {
        return this.fridaClient.call(method, args);
    }

    /**
     * After a class is accepted in REVIEW → AUTO, run pass 2 (match its fields and
     * methods) and insert the resulting records into the live MigrationResult.
     * Returns the records that were inserted, for the WS broadcast payload.
     */
    applyClassPass2(oldClassObf: string, newClassObf: string): {
        auto: import("./core/types.js").MigrationAutoRecord[];
        review: import("./core/types.js").MigrationReviewRecord[];
        lost: import("./core/types.js").MigrationLostRecord[];
    } {
        const empty = { auto: [], review: [], lost: [] };
        if (!this.currentMigrations || !this.currentProfile) return empty;
        const oldCls = this.currentMigrations.oldFps.find((f) => f.obfName === oldClassObf);
        const newCls = this.currentMigrations.currentFps.find((f) => f.obfName === newClassObf);
        if (!oldCls || !newCls) return empty;

        const sub = matchClassMembers(
            oldCls,
            newCls,
            this.currentMigrations.oldMethodLabels,
            this.currentMigrations.oldFieldLabels,
        );
        // Apply auto labels immediately
        for (const r of sub.auto) {
            this.currentProfile.labels.set(r.key, r.label);
        }
        this.currentProfile.labels.scheduleFlush();
        // Insert into live result
        this.currentMigrations.result.auto.push(...sub.auto);
        this.currentMigrations.result.review.push(...sub.review);
        this.currentMigrations.result.lost.push(...sub.lost);
        return sub;
    }

    /**
     * After a class is rejected in REVIEW → LOST, mark all its labeled fields/methods
     * as LOST too (they had no class to migrate against).
     */
    applyClassRejectCascade(oldClassObf: string): import("./core/types.js").MigrationLostRecord[] {
        if (!this.currentMigrations) return [];
        const out: import("./core/types.js").MigrationLostRecord[] = [];
        for (const [k, label] of Object.entries(this.currentMigrations.oldMethodLabels)) {
            if (k.startsWith(oldClassObf + ".")) {
                const methodName = k.slice(oldClassObf.length + 1);
                out.push({
                    key: { kind: "method", className: oldClassObf, methodName },
                    oldObf: k,
                    label,
                    reason: "parent class rejected by user",
                    parentClassMigration: oldClassObf,
                });
            }
        }
        for (const [k, label] of Object.entries(this.currentMigrations.oldFieldLabels)) {
            if (k.startsWith(oldClassObf + ".")) {
                const fieldName = k.slice(oldClassObf.length + 1);
                out.push({
                    key: { kind: "field", className: oldClassObf, fieldName },
                    oldObf: k,
                    label,
                    reason: "parent class rejected by user",
                    parentClassMigration: oldClassObf,
                });
            }
        }
        this.currentMigrations.result.lost.push(...out);
        return out;
    }

    async attach(pid: number, opts: { skipFridaAttach?: boolean } = {}): Promise<Profile> {
        if (this.attachInFlight) {
            // A previous attach is still in flight. Wait for it to finish or fail,
            // then proceed (the user wants the LATEST pid attached).
            try { await this.attachInFlight; } catch { /* previous failed; we'll retry */ }
        }
        this.attachInFlight = this._doAttach(pid, opts);
        try {
            return await this.attachInFlight;
        } finally {
            this.attachInFlight = null;
        }
    }

    private async _doAttach(pid: number, opts: { skipFridaAttach?: boolean } = {}): Promise<Profile> {
        if (!opts.skipFridaAttach) await this.fridaClient.attach(pid);

        const detected = await detectBuildId(this.fridaClient);

        const gameName = await this.deriveGameName();
        let profile: Profile;
        let isNewProfile = false;
        try {
            profile = await this.profileManager.loadProfile(gameName, detected.buildId);
        } catch {
            const previous = await this.profileManager.findMostRecentBuild(gameName, detected.buildId);
            profile = await this.profileManager.createProfile({
                gameName,
                buildId: detected.buildId,
                buildIdSource: detected.source,
                derivedFromBuildId: previous ?? undefined,
            });
            isNewProfile = true;
        }

        // Gather current fingerprints from the agent.
        let currentFps: ClassFingerprint[] = [];
        try {
            currentFps = await this.fridaClient.call<ClassFingerprint[]>("listClassFingerprints");
        } catch (e) {
            console.warn("listClassFingerprints failed:", e);
        }

        // Run migrations when the profile was freshly derived from a previous build.
        if (isNewProfile && profile.manifest.derivedFrom) {
            const previousBuildId = profile.manifest.derivedFrom.split("/")[1];
            const oldFps = await this.profileManager.loadFingerprints(gameName, previousBuildId);
            if (oldFps && currentFps.length > 0) {
                const oldLabels = await this.profileManager.loadProfileLabels(gameName, previousBuildId);
                const oldMethodLabels = await this.profileManager.loadProfileMethodLabels(gameName, previousBuildId);
                const oldFieldLabels = await this.profileManager.loadProfileFieldLabels(gameName, previousBuildId);
                const oldLabelFingerprints = await this.profileManager.loadProfileLabelFingerprints(gameName, previousBuildId);
                const result = matchFingerprints({
                    oldFps,
                    newFps: currentFps,
                    oldLabels,
                    oldMethodLabels,
                    oldFieldLabels,
                    oldLabelFingerprints,
                });
                for (const m of result.auto) {
                    profile.labels.set(m.key, m.label);
                }
                await profile.labels.flush();
                this.currentMigrations = {
                    result, oldFps, currentFps,
                    oldMethodLabels, oldFieldLabels,
                };
            }
        }

        // Persist fingerprints for the current build.
        if (currentFps.length > 0) {
            try {
                await this.profileManager.saveFingerprints(profile, currentFps);
            } catch (e) {
                console.warn("saveFingerprints failed:", e);
            }
        }

        this.currentProfile = profile;

        const storage = new DiskPluginStorage(profile.rootPath, "hooks");
        this.currentHookStore = new HookStore(storage, {
            call: <T>(m: string, a?: unknown[]) => this.fridaClient.call<T>(m, a),
        });

        this.currentFrameStore = new FrameStore(RING_BUFFER_SIZE);
        const networkStorage = new DiskPluginStorage(profile.rootPath, "network");
        this.currentSerializerConfig = new SerializerConfigStore(networkStorage);

        // Auto-detect serializer patterns ONLY when the config is empty for this profile
        // (i.e. first attach of a fresh profile, or one the user emptied). This preserves
        // any user customization across re-attaches.
        if (this.currentSerializerConfig.get().entries.length === 0) {
            try {
                const proposed = await detectSerializers({
                    call: <T>(m: string, a?: unknown[]) => this.fridaClient.call<T>(m, a),
                });
                if (proposed.length > 0) {
                    this.currentSerializerConfig.replace(proposed);
                    console.log(`[network] auto-detected ${proposed.length} serializer entries`);
                }
            } catch (e) {
                console.warn("detectSerializers failed:", e);
            }
        }

        const frameAddedHandler = (f: NetworkFrame) => this.emit("network-frame-added", f);
        const clearedHandler = () => this.emit("network-frames-cleared");
        this.currentFrameStore.on("frame-added", frameAddedHandler);
        this.currentFrameStore.on("cleared", clearedHandler);
        const fs = this.currentFrameStore;
        this.disposeListeners.push(() => {
            fs.off("frame-added", frameAddedHandler);
            fs.off("cleared", clearedHandler);
        });
        this.disposeListeners.push(
            this.currentSerializerConfig.onChange(() => this.emit("serializer-config-change")),
        );

        this.currentInstanceRegistry = new InstanceRegistry();
        this.currentHistoryStore = new HistoryStore();
        const instancesStorage = new DiskPluginStorage(profile.rootPath, "instances");
        this.currentRecipeStore = new RecipeStore(instancesStorage);
        this.instancesReadOnly = true;  // safe default at every attach

        this.disposeListeners.push(
            this.currentInstanceRegistry.onChange(() => this.emit("instance-registry-changed")),
        );
        this.disposeListeners.push(
            this.currentHistoryStore.onChange(() => this.emit("instance-history-changed")),
        );
        this.disposeListeners.push(
            this.currentRecipeStore.onChange(() => this.emit("recipe-store-changed")),
        );

        try {
            const scriptsDir = path.join(profile.rootPath, "plugins", "scripts");
            emitScriptsTypes(scriptsDir);
            const loader = new ScriptLoader(scriptsDir);
            await loader.start();
            loader.on("change", (entry) => this.emit("script-list-changed", entry));
            loader.on("remove", (id)    => this.emit("script-list-changed", { removed: id }));
            this.currentScriptLoader = loader;

            const runner = new ScriptRunner(
                loader,
                {
                    instanceRegistry: this.currentInstanceRegistry,
                    hookStore:        this.currentHookStore,
                    frameStore:       this.currentFrameStore,
                    agentCall:        (m, a) => this.fridaClient.call(m, a),
                    resolveLabel:     (l) => l, // v1.4: identity. Friendly→obf wiring deferred.
                },
                buildToolkit,
            );
            runner.on("log",    (e) => this.emit("script-log", e));
            runner.on("result", (r) => this.emit("script-result", r));
            this.currentScriptRunner = runner;
        } catch (err) {
            // Scripts plugin failed to init — degrade gracefully, attach still succeeds.
            console.warn("[scripts] init failed, running session without script support:", err instanceof Error ? err.message : err);
            // Best-effort cleanup of anything that did get set:
            if (this.currentScriptLoader) {
                void this.currentScriptLoader.dispose();
                this.currentScriptLoader = null;
            }
            this.currentScriptRunner = null;
        }

        // Forward label/annotation events so the WS bridge can broadcast them.
        // Capture disposers so they can be cleaned up on detach.
        this.disposeListeners.push(
            profile.labels.onChange((evt) => this.emit("label-change", evt)),
        );
        this.disposeListeners.push(
            profile.annotations.onChange((evt) => this.emit("annotation-change", evt)),
        );
        this.disposeListeners.push(
            this.currentHookStore.onChange(() => this.emit("hook-store-change")),
        );

        // Update manifest stats (idempotent, best-effort).
        await this.profileManager
            .updateStats(profile)
            .catch((e) => console.warn("updateStats failed:", e));

        // Pre-warm the agent's explorer index so the first user click is instant.
        try {
            await this.fridaClient.call<{ assemblies: number; classes: number }>(
                "prewarmExplorerIndex",
            );
        } catch (e) {
            console.warn("prewarmExplorerIndex failed:", e);
        }

        this.emit("profile-attached", profile);
        return profile;
    }

    async detach(): Promise<void> {
        // fridaClient.detach() emits "detached" → handleDetach() clears state.
        await this.fridaClient.detach();
    }

    private handleDetach(): void {
        if (this.currentProfile) {
            // Drain pending writes before clearing.
            void this.currentProfile.labels.flush().catch(() => {});
            void this.currentProfile.annotations.flush().catch(() => {});
        }
        for (const dispose of this.disposeListeners) {
            try { dispose(); } catch { /* swallow */ }
        }
        this.disposeListeners = [];
        this.currentProfile = null;
        this.currentHookStore = null;
        this.currentFrameStore = null;
        this.currentSerializerConfig = null;
        this.currentMigrations = null;
        this.currentInstanceRegistry = null;
        this.currentHistoryStore = null;
        this.currentRecipeStore = null;
        this.currentScanMatches = [];
        if (this.currentScriptLoader) { void this.currentScriptLoader.dispose(); this.currentScriptLoader = null; }
        if (this.currentScriptRunner) { this.currentScriptRunner.dispose(); this.currentScriptRunner = null; }
        this.instancesReadOnly = true;
        this.emit("profile-detached");
    }

    private async deriveGameName(): Promise<string> {
        try {
            const dataPath = await this.fridaClient.call<string>("getDataPath");
            if (!dataPath) return "unknown-process";
            const seg = dataPath.split(/[\\/]/).filter(Boolean).pop() ?? "";
            return seg.replace(/_Data$/i, "").toLowerCase() || "unknown-process";
        } catch {
            return "unknown-process";
        }
    }
}
