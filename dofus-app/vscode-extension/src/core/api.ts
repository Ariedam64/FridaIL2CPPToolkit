// CoreApi — the surface plugins import.
//
// In v1 there are no separate plugin extensions; plugins live as folders
// inside this same extension. They import this module directly.

import * as vscode from "vscode";

import { DiskPluginStorage } from "./plugin-storage";
import type { LabelStore } from "./labels";
import type { AnnotationStore } from "./annotations";
import type { Profile } from "./profile";
import type { RpcClient } from "./types";

export interface PluginStorage {
    get<T>(key: string): T | null;
    set<T>(key: string, value: T): void;
    delete(key: string): void;
    list(): string[];
}

export interface WebviewOptions {
    title: string;
    html: string;
    column?: vscode.ViewColumn;
    retainContextWhenHidden?: boolean;
}

export interface CoreApi {
    readonly profile: {
        current(): Profile | null;
        onAttach: vscode.EventEmitter<Profile>;
        onDetach: vscode.EventEmitter<void>;
    };
    readonly labels: LabelStore;
    readonly annotations: AnnotationStore;
    storage(pluginId: string): PluginStorage;
    rpc: {
        call<T>(method: string, args?: unknown[]): Promise<T>;
    };
    ui: {
        addView(viewId: string, provider: vscode.TreeDataProvider<unknown>): vscode.Disposable;
        addCommand(commandId: string, callback: (...args: unknown[]) => unknown): vscode.Disposable;
        showWebview(opts: WebviewOptions): vscode.WebviewPanel;
        notify(message: string, level?: "info" | "warning" | "error"): void;
    };
    /** Frida `send()` payloads from the agent. Empty no-op event in HTTP mode. */
    readonly onAgentMessage: vscode.Event<unknown>;
}

// DiskPluginStorage now lives in plugin-storage.ts (vscode-free, testable).

export interface CoreApiDeps {
    profileEmitter: vscode.EventEmitter<Profile>;
    profileDetachEmitter: vscode.EventEmitter<void>;
    profileSource: { current(): Profile | null };
    rpc: RpcClient;
    onAgentMessage: vscode.Event<unknown>;
}

export function createCoreApi(deps: CoreApiDeps): CoreApi {
    // Storage is keyed by `${profileId}::${pluginId}` so when the user attaches
    // to a different build, plugins read/write fresh state — no cross-profile
    // bleed.
    const storages = new Map<string, DiskPluginStorage>();

    function getCurrentLabels(): LabelStore {
        const p = deps.profileSource.current();
        if (!p) throw new Error("no profile attached — labels unavailable");
        return p.labels;
    }
    function getCurrentAnnotations(): AnnotationStore {
        const p = deps.profileSource.current();
        if (!p) throw new Error("no profile attached — annotations unavailable");
        return p.annotations;
    }

    return {
        profile: {
            current: () => deps.profileSource.current(),
            onAttach: deps.profileEmitter,
            onDetach: deps.profileDetachEmitter,
        },
        get labels() { return getCurrentLabels(); },
        get annotations() { return getCurrentAnnotations(); },
        storage(pluginId: string) {
            const profile = deps.profileSource.current();
            if (!profile) {
                throw new Error("no profile attached — plugin storage unavailable");
            }
            const cacheKey = `${profile.manifest.profileId}::${pluginId}`;
            let s = storages.get(cacheKey);
            if (!s) {
                s = new DiskPluginStorage(profile.rootPath, pluginId);
                storages.set(cacheKey, s);
            }
            return s;
        },
        rpc: {
            call: <T>(method: string, args: unknown[] = []) => deps.rpc.call<T>(method, args),
        },
        ui: {
            addView: (id, provider) => vscode.window.registerTreeDataProvider(id, provider),
            addCommand: (id, cb) => vscode.commands.registerCommand(id, cb),
            showWebview: (opts) => {
                const panel = vscode.window.createWebviewPanel(
                    `frida-plugin-${Date.now()}`,
                    opts.title,
                    opts.column ?? vscode.ViewColumn.One,
                    { enableScripts: true, retainContextWhenHidden: opts.retainContextWhenHidden ?? false },
                );
                panel.webview.html = opts.html;
                return panel;
            },
            notify: (msg, lvl = "info") => {
                if (lvl === "error") vscode.window.showErrorMessage(msg);
                else if (lvl === "warning") vscode.window.showWarningMessage(msg);
                else vscode.window.showInformationMessage(msg);
            },
        },
        onAgentMessage: deps.onAgentMessage,
    };
}
