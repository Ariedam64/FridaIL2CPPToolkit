// Universal search via VSCode Quick Pick. Indexes obf names + labels and
// supports `:class`, `:method`, `:field` prefixes for filtering by kind.
//
// Note: `:rva` is not yet supported because no RPC provides per-method RVAs.

import * as vscode from "vscode";

import { filterByKind, parseSearchInput, type IndexEntry, type SearchKind } from "./search-filters";
import type { Profile } from "./profile";
import type { RpcClient } from "./types";

// Re-export pure helpers so existing imports (`from "./search"`) keep working.
export { filterByKind, parseSearchInput };
export type { IndexEntry, SearchKind };

export class UniversalSearch {
    private cache: IndexEntry[] | null = null;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
    ) {}

    invalidate(): void { this.cache = null; }

    async show(): Promise<void> {
        const items = await this.getIndex();

        const qp = vscode.window.createQuickPick<vscode.QuickPickItem & { entry: IndexEntry }>();
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;

        // Persistent kind filter — set when user types `:kind `, cleared otherwise.
        let activeKind: SearchKind | null = null;

        const setItems = (): void => {
            const filtered = filterByKind(items, activeKind);
            qp.items = filtered.map((e) => ({
                label: e.label,
                description: e.description,
                detail: e.detail,
                entry: e,
            }));
            qp.placeholder = activeKind === null
                ? "Search class/method/field by obf or label. Prefix :class :method :field"
                : `Filter: ${activeKind}. Type to search; type a new :prefix to switch kind.`;
        };

        const onValue = (raw: string): void => {
            const parsed = parseSearchInput(raw);
            if (parsed.kind !== null) {
                activeKind = parsed.kind;
                // Strip the prefix; this re-fires onDidChangeValue with the
                // bare query, which falls into the else branch below.
                qp.value = parsed.query;
                setItems();
                return;
            }
            setItems();
        };

        setItems();
        qp.onDidChangeValue(onValue);

        const pick = await new Promise<(vscode.QuickPickItem & { entry: IndexEntry }) | undefined>((resolve) => {
            qp.onDidAccept(() => {
                resolve(qp.selectedItems[0]);
                qp.hide();
            });
            qp.onDidHide(() => resolve(undefined));
            qp.show();
        });
        qp.dispose();

        if (!pick) return;
        await vscode.commands.executeCommand(pick.entry.target.command, ...pick.entry.target.args);
    }

    private async getIndex(): Promise<IndexEntry[]> {
        if (this.cache) return this.cache;

        const profile = this.profileSource.current();
        const out: IndexEntry[] = [];

        try {
            const assemblies = await this.rpc.call<Array<{ name: string; classes: number }>>("listAssembliesInfo");
            for (const a of assemblies) {
                const namespaces = await this.rpc.call<Array<{ ns: string; classes: number }>>("listNamespaces", [a.name]);
                for (const n of namespaces) {
                    const classes = await this.rpc.call<string[]>("listClassesIn", [a.name, n.ns]);
                    for (const obf of classes) {
                        const fullName = n.ns ? `${n.ns}.${obf}` : obf;
                        const friendly = profile?.labels.get({ kind: "class", className: obf }) ?? null;
                        out.push({
                            kind: "class",
                            label: friendly ?? obf,
                            description: friendly ? `[${fullName}]` : (n.ns ? n.ns : ""),
                            detail: `${a.name} / ${n.ns || "(root)"}`,
                            target: { command: "frida.openClassDetail", args: [fullName] },
                        });
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`search index build failed: ${msg}`);
        }

        // Method and field labels — only the ones the user actually renamed.
        // We can't enumerate all members from the agent without a per-class
        // round-trip, so for v1 we surface labeled members only.
        if (profile) {
            const exported = profile.labels.bulkExport();
            for (const [key, entry] of Object.entries(exported.methods)) {
                const dot = key.indexOf(".");
                if (dot < 0) continue;
                const className = key.slice(0, dot);
                const methodName = key.slice(dot + 1);
                out.push({
                    kind: "method",
                    label: entry.label,
                    description: `[${className}.${methodName}]`,
                    detail: "method",
                    target: { command: "frida.openClassDetail", args: [className] },
                });
            }
            for (const [key, entry] of Object.entries(exported.fields)) {
                const dot = key.indexOf(".");
                if (dot < 0) continue;
                const className = key.slice(0, dot);
                const fieldName = key.slice(dot + 1);
                out.push({
                    kind: "field",
                    label: entry.label,
                    description: `[${className}.${fieldName}]`,
                    detail: "field",
                    target: { command: "frida.openClassDetail", args: [className] },
                });
            }
        }

        this.cache = out;
        return out;
    }
}
