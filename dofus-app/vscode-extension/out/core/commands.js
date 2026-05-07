"use strict";
// All command handlers, registered as a group from extension.activate().
// Keeps the activation file slim.
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
exports.registerCommands = registerCommands;
const vscode = __importStar(require("vscode"));
const class_detail_1 = require("./webviews/class-detail");
const migration_review_1 = require("./webviews/migration-review");
let showObfNames = false;
function registerCommands(deps) {
    const profileNeeded = (cb) => async (...args) => {
        const p = deps.profileSource.current();
        if (!p) {
            vscode.window.showWarningMessage("No profile attached. Connect Frida first.");
            return;
        }
        await cb(p, ...args);
    };
    const cmds = [];
    cmds.push(vscode.commands.registerCommand("frida.refresh", () => {
        deps.refresh();
    }));
    cmds.push(vscode.commands.registerCommand("frida.search", () => deps.showSearch()));
    cmds.push(vscode.commands.registerCommand("frida.openClassDetail", async (obfName) => {
        const target = obfName ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!target)
            return;
        await (0, class_detail_1.openClassDetail)(target, deps.rpc, deps.profileSource);
    }));
    cmds.push(vscode.commands.registerCommand("frida.renameClass", profileNeeded(async (p, obfNameArg) => {
        const obf = obfNameArg ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf)
            return;
        const key = { kind: "class", className: obf };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${obf} →`, value: current });
        if (next === undefined)
            return;
        if (next === "")
            p.labels.remove(key);
        else
            p.labels.set(key, next);
        p.labels.scheduleFlush();
        deps.refresh();
    })));
    cmds.push(vscode.commands.registerCommand("frida.renameMethod", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls)
            return;
        const meth = await vscode.window.showInputBox({ prompt: "Method obf name" });
        if (!meth)
            return;
        const key = { kind: "method", className: cls, methodName: meth };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${meth} →`, value: current });
        if (next === undefined)
            return;
        if (next === "")
            p.labels.remove(key);
        else
            p.labels.set(key, next);
        p.labels.scheduleFlush();
        deps.refresh();
    })));
    cmds.push(vscode.commands.registerCommand("frida.renameField", profileNeeded(async (p) => {
        const cls = await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!cls)
            return;
        const fld = await vscode.window.showInputBox({ prompt: "Field obf name" });
        if (!fld)
            return;
        const key = { kind: "field", className: cls, fieldName: fld };
        const current = p.labels.get(key) ?? "";
        const next = await vscode.window.showInputBox({ prompt: `Rename ${cls}.${fld} →`, value: current });
        if (next === undefined)
            return;
        if (next === "")
            p.labels.remove(key);
        else
            p.labels.set(key, next);
        p.labels.scheduleFlush();
        deps.refresh();
    })));
    cmds.push(vscode.commands.registerCommand("frida.toggleBookmark", profileNeeded(async (p, obfArg) => {
        const obf = obfArg ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf)
            return;
        const key = { kind: "class", className: obf };
        p.annotations.toggleBookmark(key);
        p.annotations.scheduleFlush();
        deps.refresh();
    })));
    cmds.push(vscode.commands.registerCommand("frida.addNote", profileNeeded(async (p, obfArg) => {
        const obf = obfArg ?? await vscode.window.showInputBox({ prompt: "Class obf name" });
        if (!obf)
            return;
        const key = { kind: "class", className: obf };
        const current = p.annotations.getNote(key) ?? "";
        const next = await vscode.window.showInputBox({
            prompt: `Note for ${obf} (markdown)`,
            value: current,
        });
        if (next === undefined)
            return;
        if (next === "")
            p.annotations.removeNote(key);
        else
            p.annotations.setNote(key, next);
        p.annotations.scheduleFlush();
        deps.refresh();
    })));
    cmds.push(vscode.commands.registerCommand("frida.toggleObfNames", () => {
        showObfNames = !showObfNames;
        deps.onShowObfNamesToggled(showObfNames);
        vscode.window.showInformationMessage(showObfNames ? "Showing obf names alongside labels"
            : "Hiding obf names");
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
        if (!uri)
            return;
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2)));
        vscode.window.showInformationMessage(`Exported ${Object.keys(data.classes).length} class labels`);
    })));
    cmds.push(vscode.commands.registerCommand("frida.importLabels", profileNeeded(async (p) => {
        const uris = await vscode.window.showOpenDialog({ filters: { JSON: ["json"] }, canSelectMany: false });
        if (!uris || uris.length === 0)
            return;
        const buf = await vscode.workspace.fs.readFile(uris[0]);
        try {
            const data = JSON.parse(Buffer.from(buf).toString("utf-8"));
            const result = p.labels.bulkImport(data);
            await p.labels.flush();
            vscode.window.showInformationMessage(`Imported ${result.imported}, skipped ${result.skipped}`);
            deps.refresh();
        }
        catch (e) {
            vscode.window.showErrorMessage(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    })));
    cmds.push(vscode.commands.registerCommand("frida.openMigrationReview", profileNeeded(async (p, oldObfArg) => {
        const oldObf = oldObfArg
            ?? await vscode.window.showInputBox({ prompt: "Old obf class name to review" });
        if (!oldObf)
            return;
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
            .filter((c) => c !== null);
        if (candidates.length === 0) {
            vscode.window.showErrorMessage(`No candidate fingerprints available for ${oldObf}`);
            return;
        }
        await (0, migration_review_1.openMigrationReview)({ oldObf, label: entry.label, oldFingerprint: oldFp, candidates }, async (newObf) => {
            p.labels.set({ kind: "class", className: newObf }, entry.label);
            await p.labels.flush();
            deps.migrationsProvider.acceptReview(oldObf, newObf);
            deps.refresh();
            vscode.window.showInformationMessage(`Accepted: ${entry.label} → ${newObf}`);
        }, () => {
            deps.migrationsProvider.rejectReview(oldObf);
            deps.refresh();
            vscode.window.showInformationMessage(`Rejected: ${entry.label} marked as lost`);
        });
    })));
    cmds.push(vscode.commands.registerCommand("frida.showProfileInfo", () => {
        const p = deps.profileSource.current();
        if (!p) {
            vscode.window.showWarningMessage("No profile attached.");
            return;
        }
        const m = p.manifest;
        vscode.window.showInformationMessage(`Profile: ${m.profileId}\nBuild: ${m.buildId} (${m.buildIdSource})\n` +
            `Labels: ${m.stats.totalLabels}, Bookmarks: ${m.stats.totalBookmarks}, Notes: ${m.stats.totalNotes}`, { modal: true });
    }));
    // Direct-Frida-only commands
    if (deps.fridaDirect) {
        const direct = deps.fridaDirect;
        cmds.push(vscode.commands.registerCommand("frida.attachToProcess", async () => {
            let processes;
            try {
                processes = await direct.listProcesses();
            }
            catch (e) {
                vscode.window.showErrorMessage(`Failed to enumerate processes: ${e instanceof Error ? e.message : String(e)}\n` +
                    `Make sure frida-server is running (or you have permissions on this OS).`);
                return;
            }
            const pick = await vscode.window.showQuickPick(processes.map((p) => ({
                label: p.name,
                description: `pid=${p.pid}`,
                pid: p.pid,
            })), {
                placeHolder: "Pick a process to attach to",
                matchOnDescription: true,
            });
            if (!pick)
                return;
            try {
                const info = await direct.attach(pick.pid);
                vscode.window.showInformationMessage(`Attached to ${info.name} (pid=${info.pid})`);
                if (deps.onAttachedReinit) {
                    await deps.onAttachedReinit();
                }
                deps.refresh();
            }
            catch (e) {
                vscode.window.showErrorMessage(`Attach failed: ${e instanceof Error ? e.message : String(e)}`);
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
//# sourceMappingURL=commands.js.map