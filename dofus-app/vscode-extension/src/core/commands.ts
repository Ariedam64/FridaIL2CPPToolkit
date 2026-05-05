// All command handlers, registered as a group from extension.activate().
// Keeps the activation file slim.

import * as vscode from "vscode";

import { openClassDetail } from "./webviews/class-detail";
import { openMigrationReview } from "./webviews/migration-review";
import type { MigrationsProvider } from "./explorer";
import type { Profile } from "./profile";
import type { LabelKey, RpcClient } from "./types";
import type { FridaDirectClient } from "./frida-direct";

export interface CommandsDeps {
    rpc: RpcClient;
    profileSource: { current(): Profile | null };
    refresh: () => void;
    onShowObfNamesToggled: (showing: boolean) => void;
    showSearch: () => Promise<void>;
    migrationsProvider: MigrationsProvider;
    /** Optional — present when running in direct-Frida mode. */
    fridaDirect?: FridaDirectClient;
    /** Called after a successful attach to trigger profile init. */
    onAttachedReinit?: () => Promise<void>;
    /** Called after a successful detach so plugins can react (e.g. fire profileDetachEmitter). */
    onDetach?: () => void;
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
        p.labels.scheduleFlush();
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
        p.labels.scheduleFlush();
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
        p.labels.scheduleFlush();
        deps.refresh();
    })));

    cmds.push(vscode.commands.registerCommand("frida.toggleBookmark", profileNeeded(async (p, obfArg) => {
        const obf = (obfArg as string | undefined) ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf) return;
        const key: LabelKey = { kind: "class", className: obf };
        p.annotations.toggleBookmark(key);
        p.annotations.scheduleFlush();
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
        p.annotations.scheduleFlush();
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
            p.labels.scheduleFlush();
            deps.refresh();
        }
    })));

    cmds.push(vscode.commands.registerCommand("frida.redoRename", profileNeeded(async (p) => {
        if (p.labels.redo()) {
            p.labels.scheduleFlush();
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

    cmds.push(vscode.commands.registerCommand("frida.openMigrationReview", profileNeeded(async (p, oldObfArg) => {
        const oldObf = (oldObfArg as string | undefined)
            ?? await vscode.window.showInputBox({ prompt: "Old obf class name to review" });
        if (!oldObf) return;

        const result = deps.migrationsProvider.getResult();
        const entry = result.review.find((m) => m.oldObf === oldObf);
        if (!entry) {
            vscode.window.showWarningMessage(`No pending review for ${oldObf}`);
            return;
        }
        const fps = deps.migrationsProvider.getFingerprints();
        const oldFp = fps.oldByObf.get(oldObf);
        if (!oldFp) {
            vscode.window.showErrorMessage(`Missing old fingerprint for ${oldObf} — cannot review`);
            return;
        }

        const candidates = entry.candidates
            .map((c) => {
                const fp = fps.newByObf.get(c.newObf);
                return fp ? { newObf: c.newObf, score: c.score, fingerprint: fp, reason: c.reason } : null;
            })
            .filter((c): c is NonNullable<typeof c> => c !== null);
        if (candidates.length === 0) {
            vscode.window.showErrorMessage(`No candidate fingerprints available for ${oldObf}`);
            return;
        }

        await openMigrationReview(
            { oldObf, label: entry.label, oldFingerprint: oldFp, candidates },
            async (newObf) => {
                p.labels.set({ kind: "class", className: newObf }, entry.label);
                await p.labels.flush();
                deps.migrationsProvider.acceptReview(oldObf, newObf);
                deps.refresh();
                vscode.window.showInformationMessage(
                    `Accepted: ${entry.label} → ${newObf}`,
                );
            },
            () => {
                deps.migrationsProvider.rejectReview(oldObf);
                deps.refresh();
                vscode.window.showInformationMessage(
                    `Rejected: ${entry.label} marked as lost`,
                );
            },
        );
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

    // Direct-Frida-only commands
    if (deps.fridaDirect) {
        const direct = deps.fridaDirect;

        cmds.push(vscode.commands.registerCommand("frida.attachToProcess", async () => {
            let processes: Awaited<ReturnType<typeof direct.listProcesses>>;
            try {
                processes = await direct.listProcesses();
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Failed to enumerate processes: ${e instanceof Error ? e.message : String(e)}\n` +
                    `Make sure frida-server is running (or you have permissions on this OS).`,
                );
                return;
            }

            const pick = await vscode.window.showQuickPick(
                processes.map((p) => ({
                    label: p.name,
                    description: `pid=${p.pid}`,
                    pid: p.pid,
                })),
                {
                    placeHolder: "Pick a process to attach to",
                    matchOnDescription: true,
                },
            );
            if (!pick) return;

            try {
                const info = await direct.attach(pick.pid);
                vscode.window.showInformationMessage(`Attached to ${info.name} (pid=${info.pid})`);
                if (deps.onAttachedReinit) {
                    await deps.onAttachedReinit();
                }
                deps.refresh();
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Attach failed: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }));

        cmds.push(vscode.commands.registerCommand("frida.detach", async () => {
            await direct.detach();
            deps.onDetach?.();
            vscode.window.showInformationMessage("Detached from Frida");
            deps.refresh();
        }));
    }

    return cmds;
}
