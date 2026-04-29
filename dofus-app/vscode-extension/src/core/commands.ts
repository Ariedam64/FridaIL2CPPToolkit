// All command handlers, registered as a group from extension.activate().
// Keeps the activation file slim.

import * as vscode from "vscode";

import { openClassDetail } from "./webviews/class-detail";
import type { Profile } from "./profile";
import type { LabelKey, RpcClient } from "./types";

export interface CommandsDeps {
    rpc: RpcClient;
    profileSource: { current(): Profile | null };
    refresh: () => void;
    onShowObfNamesToggled: (showing: boolean) => void;
    showSearch: () => Promise<void>;
}

let showObfNames = false;

export function registerCommands(deps: CommandsDeps): vscode.Disposable[] {
    const profileNeeded = (cb: (p: Profile, ...rest: unknown[]) => unknown | Promise<unknown>) =>
        async (...args: unknown[]) => {
            const p = deps.profileSource.current();
            if (!p) {
                vscode.window.showWarningMessage("No profile attached. Connect Frida first.");
                return;
            }
            await cb(p, ...args);
        };

    const cmds: vscode.Disposable[] = [];

    cmds.push(vscode.commands.registerCommand("frida.refresh", () => {
        deps.refresh();
    }));

    cmds.push(vscode.commands.registerCommand("frida.search", () => deps.showSearch()));

    cmds.push(vscode.commands.registerCommand("frida.openClassDetail", async (obfName?: string) => {
        const target = obfName ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!target) return;
        await openClassDetail(target, deps.rpc, deps.profileSource);
    }));

    cmds.push(vscode.commands.registerCommand("frida.renameClass", profileNeeded(async (p, obfNameArg) => {
        const obf = (obfNameArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${obf} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.renameMethod", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls) return;
        const meth = await vscode.window.showInputBox({ prompt: "Method obf name" });
        if (!meth) return;
        const key: LabelKey = { kind: "method", className: cls, methodName: meth };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${meth} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.renameField", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls) return;
        const fld = await vscode.window.showInputBox({ prompt: "Field obf name" });
        if (!fld) return;
        const key: LabelKey = { kind: "field", className: cls, fieldName: fld };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${fld} →`, value: current });
        if (next === undefined) return;
        if (next === "") p.labels.remove(key);
        else p.labels.set(key, next);
        await p.labels.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.toggleBookmark", profileNeeded(async (p, obfArg) => {
        const obf = (obfArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        p.annotations.toggleBookmark(key);
        await p.annotations.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.addNote", profileNeeded(async (p, obfArg) => {
        const obf = (obfArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        const current = p.annotations.getNote(key) ?? "";
        const next = await vscode.window.showInputBox({
            prompt: `Note for ${obf} (markdown)`,
            value: current,
        });
        if (next === undefined) return;
        if (next === "") p.annotations.removeNote(key);
        else p.annotations.setNote(key, next);
        await p.annotations.flush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.toggleObfNames", () => {
        showObfNames = !showObfNames;
        deps.onShowObfNamesToggled(showObfNames);
        vscode.window.showInformationMessage(
            showObfNames ? "Showing obf names alongside labels"
                         : "Hiding obf names",
        );
    }));

    cmds.push(vscode.commands.registerCommand("frida.undoRename", profileNeeded(async (p) => {
        if (p.labels.undo()) {
            await p.labels.flush();
            deps.refresh();
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.redoRename", profileNeeded(async (p) => {
        if (p.labels.redo()) {
            await p.labels.flush();
            deps.refresh();
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.exportLabels", profileNeeded(async (p) => {
        const data = p.labels.bulkExport();
        const uri = await vscode.window.showSaveDialog({ filters: { JSON: ["json"] }, defaultUri: vscode.Uri.file("labels.json") });
        if (!uri) return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2)));
        vscode.window.showInformationMessage(`Exported ${Object.keys(data.classes).length} class labels`);
    })));

    cmds.push(vscode.commands.registerCommand("frida.importLabels", profileNeeded(async (p) => {
        const uris = await vscode.window.showOpenDialog({ filters: { JSON: ["json"] }, canSelectMany: false });
        if (!uris || uris.length === 0) return;
        const buf = await vscode.workspace.fs.readFile(uris[0]);
        try {
            const data = JSON.parse(Buffer.from(buf).toString("utf-8"));
            const result = p.labels.bulkImport(data);
            await p.labels.flush();
            vscode.window.showInformationMessage(`Imported ${result.imported}, skipped ${result.skipped}`);
            deps.refresh();
        } catch (e) {
            vscode.window.showErrorMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.showProfileInfo", () => {
        const p = deps.profileSource.current();
        if (!p) {
            vscode.window.showWarningMessage("No profile attached.");
            return;
        }
        const m = p.manifest;
        vscode.window.showInformationMessage(
            `Profile: ${m.profileId}\nBuild: ${m.buildId} (${m.buildIdSource})\n` +
            `Labels: ${m.stats.totalLabels}, Bookmarks: ${m.stats.totalBookmarks}, Notes: ${m.stats.totalNotes}`,
            { modal: true },
        );
    }));

    return cmds;
}
