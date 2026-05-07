"use strict";
// Sidebar tree views:
//   1. Process Explorer  — assemblies → namespaces → classes → members
//   2. Bookmarks         — flat list of bookmarked keys
//   3. Migrations        — review queue + auto-migrated audit list
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
exports.MigrationsProvider = exports.BookmarksProvider = exports.ProcessExplorerProvider = void 0;
const vscode = __importStar(require("vscode"));
class ProcessExplorerProvider {
    rpc;
    profileSource;
    _changed = new vscode.EventEmitter();
    onDidChangeTreeData = this._changed.event;
    showObfNames = false;
    constructor(rpc, profileSource) {
        this.rpc = rpc;
        this.profileSource = profileSource;
    }
    refresh() { this._changed.fire(); }
    setShowObfNames(show) {
        this.showObfNames = show;
        this.refresh();
    }
    getTreeItem(node) {
        const profile = this.profileSource.current();
        switch (node.kind) {
            case "assembly": {
                const item = new vscode.TreeItem(`${node.name} (${node.classCount})`, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("package");
                item.contextValue = "frida.assembly";
                return item;
            }
            case "namespace": {
                const label = node.ns || "(root)";
                const item = new vscode.TreeItem(`${label} (${node.classCount})`, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("symbol-namespace");
                item.contextValue = "frida.namespace";
                return item;
            }
            case "class": {
                const fullName = node.ns ? `${node.ns}.${node.obfName}` : node.obfName;
                const key = { kind: "class", className: node.obfName };
                const display = profile ? this.displayWithObfTag(profile, key) : node.obfName;
                const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("symbol-class");
                item.contextValue = "frida.class";
                item.tooltip = fullName;
                if (profile) {
                    if (profile.annotations.isBookmarked(key))
                        item.iconPath = new vscode.ThemeIcon("star-full");
                    if (profile.annotations.getNote(key))
                        item.description = "📝";
                }
                item.command = {
                    command: "frida.openClassDetail",
                    title: "Open detail",
                    arguments: [fullName],
                };
                return item;
            }
            case "member": {
                const key = node.memberKind === "method"
                    ? { kind: "method", className: node.container.className, methodName: node.obfName }
                    : { kind: "field", className: node.container.className, fieldName: node.obfName };
                const display = profile ? this.displayWithObfTag(profile, key) : node.obfName;
                const icon = node.memberKind === "method" ? "symbol-method" : "symbol-field";
                const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(icon);
                item.contextValue = `frida.${node.memberKind}`;
                item.tooltip = node.obfName;
                return item;
            }
        }
    }
    async getChildren(node) {
        try {
            if (!node) {
                const list = await this.rpc.call("listAssembliesInfo");
                return list.map((a) => ({ kind: "assembly", name: a.name, classCount: a.classes }));
            }
            if (node.kind === "assembly") {
                const list = await this.rpc.call("listNamespaces", [node.name]);
                return list.map((nsInfo) => ({
                    kind: "namespace", assembly: node.name, ns: nsInfo.ns, classCount: nsInfo.classes,
                }));
            }
            if (node.kind === "namespace") {
                const list = await this.rpc.call("listClassesIn", [node.assembly, node.ns]);
                return list.map((obfName) => ({
                    kind: "class", assembly: node.assembly, ns: node.ns, obfName,
                }));
            }
            return [];
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida RPC error: ${msg}`);
            return [];
        }
    }
    displayWithObfTag(profile, key) {
        const friendly = profile.labels.get(key);
        const obf = key.kind === "class"
            ? key.className
            : key.kind === "method" ? key.methodName : key.fieldName;
        if (!friendly)
            return obf;
        return this.showObfNames ? `${friendly} [${obf}]` : friendly;
    }
}
exports.ProcessExplorerProvider = ProcessExplorerProvider;
// ===========================================================================
// Bookmarks
// ===========================================================================
class BookmarksProvider {
    profileSource;
    _changed = new vscode.EventEmitter();
    onDidChangeTreeData = this._changed.event;
    constructor(profileSource) {
        this.profileSource = profileSource;
    }
    refresh() { this._changed.fire(); }
    getTreeItem(key) {
        const profile = this.profileSource.current();
        const display = profile ? profile.labels.display(key) : labelKeyName(key);
        const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("star-full");
        item.contextValue = "frida.bookmark";
        item.tooltip = labelKeyTooltip(key);
        if (key.kind === "class") {
            // TODO bookmarks: key.className may be a short obf if bookmarked before
            // the fullName migration. Lookup may resolve to a wrong class; auto-revert
            // protects but the user should re-bookmark from the webview.
            item.command = { command: "frida.openClassDetail", title: "Open", arguments: [key.className] };
        }
        return item;
    }
    getChildren() {
        const profile = this.profileSource.current();
        return profile ? profile.annotations.listBookmarks() : [];
    }
}
exports.BookmarksProvider = BookmarksProvider;
class MigrationsProvider {
    _changed = new vscode.EventEmitter();
    onDidChangeTreeData = this._changed.event;
    current = { auto: [], review: [], lost: [] };
    fingerprints = {
        oldByObf: new Map(),
        newByObf: new Map(),
    };
    refresh() { this._changed.fire(); }
    setMigrations(result, fps) {
        this.current = result;
        if (fps) {
            this.fingerprints = {
                oldByObf: new Map(fps.old.map((fp) => [fp.obfName, fp])),
                newByObf: new Map(fps.current.map((fp) => [fp.obfName, fp])),
            };
        }
        this.refresh();
    }
    getResult() { return this.current; }
    getFingerprints() { return this.fingerprints; }
    /** Move a review entry into the auto bucket after the user accepted a candidate. */
    acceptReview(oldObf, newObf) {
        const idx = this.current.review.findIndex((m) => m.oldObf === oldObf);
        if (idx < 0)
            return;
        const entry = this.current.review[idx];
        const candidate = entry.candidates.find((c) => c.newObf === newObf);
        this.current.review.splice(idx, 1);
        this.current.auto.push({
            key: entry.key,
            label: entry.label,
            oldObf: entry.oldObf,
            newObf,
            reason: candidate
                ? `user accepted (score=${candidate.score.toFixed(3)})`
                : "user accepted",
        });
        this.refresh();
    }
    /** Move a review entry into the lost bucket after the user rejected all candidates. */
    rejectReview(oldObf) {
        const idx = this.current.review.findIndex((m) => m.oldObf === oldObf);
        if (idx < 0)
            return;
        const entry = this.current.review[idx];
        this.current.review.splice(idx, 1);
        this.current.lost.push({
            key: entry.key,
            label: entry.label,
            oldObf: entry.oldObf,
            reason: "user rejected all candidates",
        });
        this.refresh();
    }
    getTreeItem(node) {
        switch (node.kind) {
            case "section": {
                const item = new vscode.TreeItem(`${node.section.toUpperCase()} (${node.count})`, node.count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon(node.section === "auto" ? "check"
                    : node.section === "review" ? "warning"
                        : "error");
                return item;
            }
            case "auto": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} → ${node.newObf}`, vscode.TreeItemCollapsibleState.None);
                item.tooltip = node.reason;
                return item;
            }
            case "review": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} (${node.topScore.toFixed(2)})`, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("warning");
                item.command = {
                    command: "frida.openMigrationReview",
                    title: "Review",
                    arguments: [node.oldObf],
                };
                return item;
            }
            case "lost": {
                const item = new vscode.TreeItem(`${node.label}: ${node.oldObf} (lost)`, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon("error");
                item.tooltip = node.reason;
                return item;
            }
        }
    }
    getChildren(node) {
        if (!node) {
            return [
                { kind: "section", section: "review", count: this.current.review.length },
                { kind: "section", section: "auto", count: this.current.auto.length },
                { kind: "section", section: "lost", count: this.current.lost.length },
            ];
        }
        if (node.kind === "section") {
            if (node.section === "auto") {
                return this.current.auto.map((m) => ({
                    kind: "auto",
                    oldObf: m.oldObf, newObf: m.newObf, label: m.label, reason: m.reason,
                }));
            }
            if (node.section === "review") {
                return this.current.review.map((m) => ({
                    kind: "review",
                    oldObf: m.oldObf, label: m.label,
                    topScore: m.candidates[0]?.score ?? 0,
                }));
            }
            return this.current.lost.map((m) => ({
                kind: "lost",
                oldObf: m.oldObf, label: m.label, reason: m.reason,
            }));
        }
        return [];
    }
}
exports.MigrationsProvider = MigrationsProvider;
// ===========================================================================
// Helpers
// ===========================================================================
function labelKeyName(k) {
    return k.kind === "class" ? k.className
        : k.kind === "method" ? `${k.className}.${k.methodName}`
            : `${k.className}.${k.fieldName}`;
}
function labelKeyTooltip(k) { return `${k.kind}: ${labelKeyName(k)}`; }
//# sourceMappingURL=explorer.js.map