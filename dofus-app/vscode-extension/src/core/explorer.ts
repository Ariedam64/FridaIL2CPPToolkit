// Sidebar tree views:
//   1. Process Explorer  — assemblies → namespaces → classes → members
//   2. Bookmarks         — flat list of bookmarked keys
//   3. Migrations        — review queue + auto-migrated audit list

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type {
    ClassFingerprint,
    LabelKey,
    MigrationResult,
    RpcClient,
} from "./types";

// ===========================================================================
// Process Explorer
// ===========================================================================

type ExplorerNode =
    | { kind: "assembly"; name: string; classCount: number }
    | { kind: "namespace"; assembly: string; ns: string; classCount: number }
    | { kind: "class"; assembly: string; ns: string; obfName: string }
    | { kind: "member"; container: { className: string }; memberKind: "method" | "field"; obfName: string };

export class ProcessExplorerProvider implements vscode.TreeDataProvider<ExplorerNode> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;
    private showObfNames = false;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
    ) {}

    refresh(): void { this._changed.fire(); }

    setShowObfNames(show: boolean): void {
        this.showObfNames = show;
        this.refresh();
    }

    getTreeItem(node: ExplorerNode): vscode.TreeItem {
        const profile = this.profileSource.current();
        switch (node.kind) {
            case "assembly": {
                const item = new vscode.TreeItem(`${node.name} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("package");
                item.contextValue = "frida.assembly";
                return item;
            }
            case "namespace": {
                const label = node.ns || "(root)";
                const item = new vscode.TreeItem(`${label} (${node.classCount})`,
                    vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("symbol-namespace");
                item.contextValue = "frida.namespace";
                return item;
            }
            case "class": {
                const key: LabelKey = { kind: "class", className: node.obfName };
                const display = profile ? this.displayWithObfTag(profile, key) : node.obfName;
                const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon("symbol-class");
                item.contextValue = "frida.class";
                item.tooltip = node.obfName;
                if (profile) {
                    if (profile.annotations.isBookmarked(key)) item.iconPath = new vscode.ThemeIcon("star-full");
                    if (profile.annotations.getNote(key)) item.description = "📝";
                }
                item.command = {
                    command: "frida.openClassDetail",
                    title: "Open detail",
                    arguments: [node.obfName],
                };
                return item;
            }
            case "member": {
                const key: LabelKey = node.memberKind === "method"
                    ? { kind: "method", className: node.container.className, methodName: node.obfName }
                    : { kind: "field",  className: node.container.className, fieldName:  node.obfName };
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

    async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
        try {
            if (!node) {
                const list = await this.rpc.call<Array<{ name: string; classes: number }>>("listAssembliesInfo");
                return list.map((a) => ({ kind: "assembly", name: a.name, classCount: a.classes }));
            }
            if (node.kind === "assembly") {
                const list = await this.rpc.call<Array<{ ns: string; classes: number }>>("listNamespaces", [node.name]);
                return list.map((nsInfo) => ({
                    kind: "namespace", assembly: node.name, ns: nsInfo.ns, classCount: nsInfo.classes,
                }));
            }
            if (node.kind === "namespace") {
                const list = await this.rpc.call<string[]>("listClassesIn", [node.assembly, node.ns]);
                return list.map((obfName) => ({
                    kind: "class", assembly: node.assembly, ns: node.ns, obfName,
                }));
            }
            return [];
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`Frida RPC error: ${msg}`);
            return [];
        }
    }

    private displayWithObfTag(profile: Profile, key: LabelKey): string {
        const friendly = profile.labels.get(key);
        const obf = key.kind === "class"
            ? key.className
            : key.kind === "method" ? key.methodName : key.fieldName;
        if (!friendly) return obf;
        return this.showObfNames ? `${friendly} [${obf}]` : friendly;
    }
}

// ===========================================================================
// Bookmarks
// ===========================================================================

export class BookmarksProvider implements vscode.TreeDataProvider<LabelKey> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;

    constructor(private readonly profileSource: { current(): Profile | null }) {}

    refresh(): void { this._changed.fire(); }

    getTreeItem(key: LabelKey): vscode.TreeItem {
        const profile = this.profileSource.current();
        const display = profile ? profile.labels.display(key) : labelKeyName(key);
        const item = new vscode.TreeItem(display, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("star-full");
        item.contextValue = "frida.bookmark";
        item.tooltip = labelKeyTooltip(key);
        if (key.kind === "class") {
            item.command = { command: "frida.openClassDetail", title: "Open", arguments: [key.className] };
        }
        return item;
    }

    getChildren(): LabelKey[] {
        const profile = this.profileSource.current();
        return profile ? profile.annotations.listBookmarks() : [];
    }
}

// ===========================================================================
// Migrations
// ===========================================================================

type MigrationNode =
    | { kind: "section"; section: "auto" | "review" | "lost"; count: number }
    | { kind: "auto"; oldObf: string; newObf: string; label: string; reason: string }
    | { kind: "review"; oldObf: string; label: string; topScore: number }
    | { kind: "lost"; oldObf: string; label: string; reason: string };

export interface MigrationFingerprints {
    oldByObf: Map<string, ClassFingerprint>;
    newByObf: Map<string, ClassFingerprint>;
}

export class MigrationsProvider implements vscode.TreeDataProvider<MigrationNode> {
    private _changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._changed.event;
    private current: MigrationResult = { auto: [], review: [], lost: [] };
    private fingerprints: MigrationFingerprints = {
        oldByObf: new Map(),
        newByObf: new Map(),
    };

    refresh(): void { this._changed.fire(); }

    setMigrations(result: MigrationResult, fps?: { old: ClassFingerprint[]; current: ClassFingerprint[] }): void {
        this.current = result;
        if (fps) {
            this.fingerprints = {
                oldByObf: new Map(fps.old.map((fp) => [fp.obfName, fp])),
                newByObf: new Map(fps.current.map((fp) => [fp.obfName, fp])),
            };
        }
        this.refresh();
    }

    getResult(): MigrationResult { return this.current; }

    getFingerprints(): MigrationFingerprints { return this.fingerprints; }

    /** Move a review entry into the auto bucket after the user accepted a candidate. */
    acceptReview(oldObf: string, newObf: string): void {
        const idx = this.current.review.findIndex((m) => m.oldObf === oldObf);
        if (idx < 0) return;
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
    rejectReview(oldObf: string): void {
        const idx = this.current.review.findIndex((m) => m.oldObf === oldObf);
        if (idx < 0) return;
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

    getTreeItem(node: MigrationNode): vscode.TreeItem {
        switch (node.kind) {
            case "section": {
                const item = new vscode.TreeItem(
                    `${node.section.toUpperCase()} (${node.count})`,
                    node.count > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
                );
                item.iconPath = new vscode.ThemeIcon(
                    node.section === "auto" ? "check"
                    : node.section === "review" ? "warning"
                    : "error",
                );
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

    getChildren(node?: MigrationNode): MigrationNode[] {
        if (!node) {
            return [
                { kind: "section", section: "review", count: this.current.review.length },
                { kind: "section", section: "auto",   count: this.current.auto.length },
                { kind: "section", section: "lost",   count: this.current.lost.length },
            ];
        }
        if (node.kind === "section") {
            if (node.section === "auto") {
                return this.current.auto.map((m) => ({
                    kind: "auto" as const,
                    oldObf: m.oldObf, newObf: m.newObf, label: m.label, reason: m.reason,
                }));
            }
            if (node.section === "review") {
                return this.current.review.map((m) => ({
                    kind: "review" as const,
                    oldObf: m.oldObf, label: m.label,
                    topScore: m.candidates[0]?.score ?? 0,
                }));
            }
            return this.current.lost.map((m) => ({
                kind: "lost" as const,
                oldObf: m.oldObf, label: m.label, reason: m.reason,
            }));
        }
        return [];
    }
}

// ===========================================================================
// Helpers
// ===========================================================================

function labelKeyName(k: LabelKey): string {
    return k.kind === "class" ? k.className
        : k.kind === "method" ? `${k.className}.${k.methodName}`
        : `${k.className}.${k.fieldName}`;
}
function labelKeyTooltip(k: LabelKey): string { return `${k.kind}: ${labelKeyName(k)}`; }
