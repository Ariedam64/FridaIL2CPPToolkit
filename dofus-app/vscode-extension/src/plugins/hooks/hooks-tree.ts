import * as vscode from "vscode";

import type { LabelStore } from "../../core/labels";
import type { StoredHook } from "./types";
import type { HookStore } from "./hook-store";

export class HooksTreeProvider implements vscode.TreeDataProvider<StoredHook> {
    private readonly _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;

    constructor(
        private readonly store: HookStore,
        private readonly labels: () => LabelStore | null,
    ) {
        store.onChange(() => this._changed.fire());
    }

    refresh(): void { this._changed.fire(); }

    getTreeItem(h: StoredHook): vscode.TreeItem {
        const friendlyClass = this.friendlyClassName(h.spec.className);
        const friendlyMethod = this.friendlyMethodName(h.spec.className, h.spec.methodName);
        const label = `${friendlyClass}.${friendlyMethod}`;

        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        const installed = h.installedHookId !== null;
        item.iconPath = new vscode.ThemeIcon(installed ? "circle-filled" : "circle-outline");
        item.description = `[${h.spec.template}]${installed ? " ●" : ""}`;
        item.tooltip = [
            `${h.spec.className}.${h.spec.methodName}`,
            `template: ${h.spec.template}`,
            installed ? `installed: ${h.installedHookId}` : "disarmed",
        ].join("\n");
        item.contextValue = installed ? "frida.hook.installed" : "frida.hook.disarmed";
        item.command = {
            command: "frida.hooks.openLog",
            title: "Open hook log",
            arguments: [h.id],
        };
        return item;
    }

    getChildren(node?: StoredHook): StoredHook[] {
        if (node) return [];
        return this.store.list();
    }

    private friendlyClassName(obf: string): string {
        const labels = this.labels();
        return labels?.get({ kind: "class", className: obf }) ?? obf;
    }

    private friendlyMethodName(cls: string, methodObf: string): string {
        const labels = this.labels();
        return labels?.get({ kind: "method", className: cls, methodName: methodObf }) ?? methodObf;
    }
}
