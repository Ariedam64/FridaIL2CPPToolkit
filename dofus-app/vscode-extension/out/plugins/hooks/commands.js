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
exports.registerHookCommands = registerHookCommands;
// dofus-app/vscode-extension/src/plugins/hooks/commands.ts
const vscode = __importStar(require("vscode"));
const hook_spec_validation_1 = require("./hook-spec-validation");
const TEMPLATES = ["log", "log-stack", "noop", "force-return"];
async function pickSpec(initial) {
    const className = await vscode.window.showInputBox({
        prompt: "Class obf name (e.g. ecu, MapRenderer)",
        value: initial?.className ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!className)
        return undefined;
    const methodName = await vscode.window.showInputBox({
        prompt: `Method name on ${className}`,
        value: initial?.methodName ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!methodName)
        return undefined;
    const templatePick = await vscode.window.showQuickPick(TEMPLATES, {
        placeHolder: "Hook template",
    });
    if (!templatePick)
        return undefined;
    const template = templatePick;
    let forceReturnValue;
    if (template === "force-return") {
        const raw = await vscode.window.showInputBox({
            prompt: "Force-return value (literal — number, true/false, null, or quoted string)",
            value: typeof initial?.forceReturnValue === "string" ? initial.forceReturnValue : "",
        });
        if (raw === undefined)
            return undefined;
        try {
            forceReturnValue = JSON.parse(raw);
        }
        catch {
            forceReturnValue = raw; /* treat as raw string */
        }
    }
    let stackCaptureCount;
    if (template === "log-stack") {
        const raw = await vscode.window.showInputBox({
            prompt: "Stack capture count (first N hits, default 5)",
            value: String(initial?.stackCaptureCount ?? 5),
            validateInput: (v) => /^\d+$/.test(v) ? null : "must be a non-negative integer",
        });
        if (raw === undefined)
            return undefined;
        stackCaptureCount = parseInt(raw, 10);
    }
    return { template, className, methodName, forceReturnValue, stackCaptureCount };
}
function registerHookCommands(deps) {
    const { store, coreApi, openLog } = deps;
    const cmds = [];
    cmds.push(vscode.commands.registerCommand("frida.hooks.add", async () => {
        const spec = await pickSpec();
        if (!spec)
            return;
        const v = (0, hook_spec_validation_1.validateHookSpec)(spec);
        if (!v.ok) {
            vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`);
            return;
        }
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Hook installed: ${spec.className}.${spec.methodName}`);
        }
        catch (err) {
            vscode.window.showWarningMessage(`Hook saved but install failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.toggle", async (item) => {
        const target = await resolveTarget(store, item);
        if (!target)
            return;
        try {
            if (target.installedHookId === null)
                await store.install(target.id);
            else
                await store.uninstall(target.id);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.delete", async (item) => {
        const target = await resolveTarget(store, item);
        if (!target)
            return;
        const yes = await vscode.window.showWarningMessage(`Delete hook ${target.spec.className}.${target.spec.methodName}?`, { modal: true }, "Delete");
        if (yes !== "Delete")
            return;
        await store.remove(target.id);
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.edit", async (item) => {
        const target = await resolveTarget(store, item);
        if (!target)
            return;
        const spec = await pickSpec(target.spec);
        if (!spec)
            return;
        const v = (0, hook_spec_validation_1.validateHookSpec)(spec);
        if (!v.ok) {
            vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`);
            return;
        }
        try {
            await store.update(target.id, spec);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Edit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    let httpModeWarned = false;
    cmds.push(vscode.commands.registerCommand("frida.hooks.openLog", (hookIdFocus) => {
        if (!httpModeWarned) {
            const useDirect = vscode.workspace.getConfiguration("fridaToolkit").get("useDirectMode", true);
            if (!useDirect) {
                vscode.window.showWarningMessage("Hooks plugin: live event stream requires direct Frida mode. Hooks install but log will stay empty in HTTP mode.");
                httpModeWarned = true;
            }
        }
        openLog(hookIdFocus);
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.clearAll", async () => {
        const yes = await vscode.window.showWarningMessage("Uninstall every active hook? Definitions stay on disk.", { modal: true }, "Uninstall all");
        if (yes !== "Uninstall all")
            return;
        try {
            const r = await coreApi.rpc.call("clearAllHooks");
            store.markAllDisarmed();
            vscode.window.showInformationMessage(`Uninstalled ${r.count} hooks`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`clearAll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.traceMember", async (className, methodName) => {
        if (!className || !methodName) {
            vscode.window.showWarningMessage("frida.hooks.traceMember: missing className/methodName");
            return;
        }
        const spec = {
            template: "log-stack",
            className,
            methodName,
            stackCaptureCount: 5,
        };
        const v = (0, hook_spec_validation_1.validateHookSpec)(spec);
        if (!v.ok) {
            vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`);
            return;
        }
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Tracing: ${className}.${methodName} (5 stack frames)`);
            // Open log focused on this hook
            openLog(stored.id);
        }
        catch (err) {
            vscode.window.showWarningMessage(`Trace saved disarmed (install failed): ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    cmds.push(vscode.commands.registerCommand("frida.hooks.addFromMember", async (arg1, arg2) => {
        let className;
        let methodName;
        // Two call shapes:
        // 1. Programmatic: (className, methodName) — used when invoked from a different code path.
        // 2. Tree context-menu: (memberNode) — VSCode passes the tree node.
        if (typeof arg1 === "string") {
            className = arg1;
            methodName = typeof arg2 === "string" ? arg2 : undefined;
        }
        else if (arg1 && typeof arg1 === "object") {
            const node = arg1;
            if (node.kind === "member" && node.memberKind === "method"
                && node.container?.className && node.obfName) {
                className = node.container.className;
                methodName = node.obfName;
            }
        }
        if (!className || !methodName) {
            vscode.window.showWarningMessage("frida.hooks.addFromMember: missing className/methodName");
            return;
        }
        const template = await vscode.window.showQuickPick(["log", "log-stack", "noop"], { placeHolder: `Hook ${className}.${methodName} as` });
        if (!template)
            return;
        const spec = { template, className, methodName };
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Hook installed: ${className}.${methodName}`);
        }
        catch (err) {
            vscode.window.showWarningMessage(`Hook saved disarmed (install failed): ${err instanceof Error ? err.message : String(err)}`);
        }
    }));
    return cmds;
}
async function resolveTarget(store, fromArg) {
    if (fromArg && typeof fromArg === "object" && "id" in fromArg)
        return fromArg;
    const list = store.list();
    if (list.length === 0) {
        vscode.window.showInformationMessage("No hooks defined yet.");
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(list.map((h) => ({
        label: `${h.spec.className}.${h.spec.methodName}`,
        description: `[${h.spec.template}]${h.installedHookId ? " installed" : " disarmed"}`,
        hook: h,
    })), { placeHolder: "Pick a hook" });
    return pick?.hook;
}
//# sourceMappingURL=commands.js.map