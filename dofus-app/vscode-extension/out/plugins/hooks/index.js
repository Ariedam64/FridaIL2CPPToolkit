"use strict";
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
exports.activateHooksPlugin = activateHooksPlugin;
// dofus-app/vscode-extension/src/plugins/hooks/index.ts
const vscode = __importStar(require("vscode"));
const hook_store_1 = require("./hook-store");
const hook_event_bus_1 = require("./hook-event-bus");
const hooks_tree_1 = require("./hooks-tree");
const commands_1 = require("./commands");
const hook_log_1 = require("./webviews/hook-log");
function activateHooksPlugin(coreApi, _ctx) {
    const disposables = [];
    const eventBus = new hook_event_bus_1.HookEventBus(coreApi.onAgentMessage, 10_000);
    disposables.push({ dispose: () => eventBus.dispose() });
    // Lazy lookup — store creation depends on a current profile.
    let store = null;
    const ensureStore = () => {
        if (store)
            return store;
        const storage = coreApi.storage("hooks");
        store = new hook_store_1.HookStore(storage, coreApi.rpc);
        return store;
    };
    const labelsAccessor = () => {
        try {
            return coreApi.labels;
        }
        catch {
            return null;
        }
    };
    // Subscribe to agent auto-revert events. The listener is registered early
    // but defers ensureStore() until we know a profile is attached (which is
    // guaranteed if a hook fired in the first place).
    const autoRevertSub = coreApi.onAgentMessage((payload) => {
        if (!payload || typeof payload !== "object" ||
            payload.type !== "hook-auto-revert")
            return;
        const evt = payload;
        const profile = coreApi.profile.current();
        if (!profile)
            return;
        const s = ensureStore();
        const updated = s.markDisarmedByHookId(evt.hookId);
        if (updated) {
            vscode.window.showWarningMessage(`Hook auto-reverted (${evt.reason})${evt.detail ? `: ${evt.detail}` : ""}. ` +
                `Re-install from the Process Explorer tree to use the fully-qualified class name.`);
        }
    });
    disposables.push(autoRevertSub);
    // Build pieces lazily after the first attach so storage() doesn't throw.
    let bound = false;
    const bind = () => {
        if (bound)
            return;
        bound = true;
        const s = ensureStore();
        const tree = new hooks_tree_1.HooksTreeProvider(s, labelsAccessor);
        disposables.push(coreApi.ui.addView("fridaHooks", tree));
        // Reset installedHookId state on detach (no agent reverts —
        // agent already gone). Reload defs on next attach.
        disposables.push(coreApi.profile.onDetach.event(() => s.markAllDisarmed()));
        disposables.push(coreApi.profile.onAttach.event(() => s.reload()));
        const logPanel = new hook_log_1.HookLogPanel(eventBus, s);
        disposables.push({ dispose: () => logPanel.dispose() });
        const openLog = (focusHookId) => logPanel.show(focusHookId);
        disposables.push(...(0, commands_1.registerHookCommands)({ store: s, coreApi, openLog }));
    };
    if (coreApi.profile.current())
        bind();
    else
        disposables.push(coreApi.profile.onAttach.event(() => bind()));
    return vscode.Disposable.from(...disposables);
}
//# sourceMappingURL=index.js.map