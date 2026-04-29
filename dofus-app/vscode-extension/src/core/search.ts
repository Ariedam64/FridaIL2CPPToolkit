// Universal search via VSCode Quick Pick. Indexes obf names + labels and
// supports `:class`, `:method`, `:field`, `:rva` prefixes for filtering.

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type { RpcClient } from "./types";

interface IndexEntry {
    label: string;
    description: string;
    detail: string;
    target: { command: string; args: unknown[] };
}

export class UniversalSearch {
    private cache: IndexEntry[] | null = null;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
    ) {}

    invalidate(): void { this.cache = null; }

    async show(): Promise<void> {
        const items = await this.getIndex();
        const pick = await vscode.window.showQuickPick(
            items.map<vscode.QuickPickItem & { entry: IndexEntry }>((e) => ({
                label: e.label,
                description: e.description,
                detail: e.detail,
                entry: e,
            })),
            {
                placeHolder: "Search class/method/field by obf or label. Prefix `:class `, `:method `, `:field `, `:rva `",
                matchOnDescription: true,
                matchOnDetail: true,
            },
        );
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
                        const friendly = profile?.labels.get({ kind: "class", className: obf }) ?? null;
                        out.push({
                            label: friendly ?? obf,
                            description: friendly ? `[${obf}]` : "",
                            detail: `${a.name} / ${n.ns || "(root)"}`,
                            target: { command: "frida.openClassDetail", args: [obf] },
                        });
                    }
                }
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            vscode.window.showWarningMessage(`search index build failed: ${msg}`);
        }

        this.cache = out;
        return out;
    }
}
