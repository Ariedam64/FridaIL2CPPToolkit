// dofus-app/vscode-extension/src/plugins/hooks/index.ts
import * as vscode from "vscode";

import type { CoreApi } from "../../core/api";
import { HookStore } from "./hook-store";
import { HookEventBus } from "./hook-event-bus";
import { HooksTreeProvider } from "./hooks-tree";
import { registerHookCommands } from "./commands";

export function activateHooksPlugin(coreApi: CoreApi, _ctx: vscode.ExtensionContext): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    const eventBus = new HookEventBus(coreApi.onAgentMessage, 10_000);
    disposables.push({ dispose: () => eventBus.dispose() });

    // Lazy lookup — store creation depends on a current profile.
    let store: HookStore | null = null;
    const ensureStore = (): HookStore => {
        if (store) return store;
        const storage = coreApi.storage("hooks");
        store = new HookStore(storage, coreApi.rpc);
        return store;
    };
    const labelsAccessor = (): import("../../core/labels").LabelStore | null => {
        try { return coreApi.labels; } catch { return null; }
    };

    // Build pieces lazily after the first attach so storage() doesn't throw.
    let bound = false;
    const bind = (): void => {
        if (bound) return;
        bound = true;
        const s = ensureStore();
        const tree = new HooksTreeProvider(s, labelsAccessor);
        disposables.push(coreApi.ui.addView("fridaHooks", tree));

        // Reset installedHookId state on detach (no agent reverts —
        // agent already gone). Reload defs on next attach.
        disposables.push(coreApi.profile.onDetach.event(() => s.markAllDisarmed()));
        disposables.push(coreApi.profile.onAttach.event(() => s.reload()));

        const openLog = (_focusHookId?: string): void => {
            // Implemented in Task 10 — placeholder for now.
            coreApi.ui.notify("Hook Log webview coming in Task 10", "info");
        };

        disposables.push(...registerHookCommands({ store: s, coreApi, openLog }));
    };

    if (coreApi.profile.current()) bind();
    else disposables.push(coreApi.profile.onAttach.event(() => bind()));

    return vscode.Disposable.from(...disposables);
}
