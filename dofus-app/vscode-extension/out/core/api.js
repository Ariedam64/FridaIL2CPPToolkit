"use strict";
// CoreApi — the surface plugins import.
//
// In v1 there are no separate plugin extensions; plugins live as folders
// inside this same extension. They import this module directly.
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
exports.createCoreApi = createCoreApi;
const vscode = __importStar(require("vscode"));
const plugin_storage_1 = require("./plugin-storage");
function createCoreApi(deps) {
    // Storage is keyed by `${profileId}::${pluginId}` so when the user attaches
    // to a different build, plugins read/write fresh state — no cross-profile
    // bleed.
    const storages = new Map();
    function getCurrentLabels() {
        const p = deps.profileSource.current();
        if (!p)
            throw new Error("no profile attached — labels unavailable");
        return p.labels;
    }
    function getCurrentAnnotations() {
        const p = deps.profileSource.current();
        if (!p)
            throw new Error("no profile attached — annotations unavailable");
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
        storage(pluginId) {
            const profile = deps.profileSource.current();
            if (!profile) {
                throw new Error("no profile attached — plugin storage unavailable");
            }
            const cacheKey = `${profile.manifest.profileId}::${pluginId}`;
            let s = storages.get(cacheKey);
            if (!s) {
                s = new plugin_storage_1.DiskPluginStorage(profile.rootPath, pluginId);
                storages.set(cacheKey, s);
            }
            return s;
        },
        rpc: {
            call: (method, args = []) => deps.rpc.call(method, args),
        },
        ui: {
            addView: (id, provider) => vscode.window.registerTreeDataProvider(id, provider),
            addCommand: (id, cb) => vscode.commands.registerCommand(id, cb),
            showWebview: (opts) => {
                const panel = vscode.window.createWebviewPanel(`frida-plugin-${Date.now()}`, opts.title, opts.column ?? vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: opts.retainContextWhenHidden ?? false });
                panel.webview.html = opts.html;
                return panel;
            },
            notify: (msg, lvl = "info") => {
                if (lvl === "error")
                    vscode.window.showErrorMessage(msg);
                else if (lvl === "warning")
                    vscode.window.showWarningMessage(msg);
                else
                    vscode.window.showInformationMessage(msg);
            },
        },
        onAgentMessage: deps.onAgentMessage,
    };
}
//# sourceMappingURL=api.js.map