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
exports.HooksTreeProvider = void 0;
const vscode = __importStar(require("vscode"));
class HooksTreeProvider {
    store;
    labels;
    _changed = new vscode.EventEmitter();
    onDidChangeTreeData = this._changed.event;
    constructor(store, labels) {
        this.store = store;
        this.labels = labels;
        store.onChange(() => this._changed.fire());
    }
    refresh() { this._changed.fire(); }
    getTreeItem(h) {
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
    getChildren(node) {
        if (node)
            return [];
        return this.store.list();
    }
    friendlyClassName(obf) {
        const labels = this.labels();
        return labels?.get({ kind: "class", className: obf }) ?? obf;
    }
    friendlyMethodName(cls, methodObf) {
        const labels = this.labels();
        return labels?.get({ kind: "method", className: cls, methodName: methodObf }) ?? methodObf;
    }
}
exports.HooksTreeProvider = HooksTreeProvider;
//# sourceMappingURL=hooks-tree.js.map