// dofus-app/vscode-extension/src/plugins/hooks/commands.ts
import * as vscode from "vscode";

import type { CoreApi } from "../../core/api";
import { validateHookSpec } from "./hook-spec-validation";
import type { HookStore } from "./hook-store";
import type { HookTemplate, HookSpec, StoredHook } from "./types";

export interface HooksCommandDeps {
    store: HookStore;
    coreApi: CoreApi;
    /** Lazy — created on first frida.hooks.openLog call. */
    openLog: (focusHookId?: string) => void;
}

const TEMPLATES: HookTemplate[] = ["log", "log-stack", "noop", "force-return"];

async function pickSpec(initial?: HookSpec): Promise<HookSpec | undefined> {
    const className = await vscode.window.showInputBox({
        prompt: "Class obf name (e.g. ecu, MapRenderer)",
        value: initial?.className ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!className) return undefined;

    const methodName = await vscode.window.showInputBox({
        prompt: `Method name on ${className}`,
        value: initial?.methodName ?? "",
        validateInput: (v) => v.length === 0 ? "required" : null,
    });
    if (!methodName) return undefined;

    const templatePick = await vscode.window.showQuickPick(TEMPLATES, {
        placeHolder: "Hook template",
    });
    if (!templatePick) return undefined;
    const template = templatePick as HookTemplate;

    let forceReturnValue: unknown;
    if (template === "force-return") {
        const raw = await vscode.window.showInputBox({
            prompt: "Force-return value (literal — number, true/false, null, or quoted string)",
            value: typeof initial?.forceReturnValue === "string" ? initial.forceReturnValue : "",
        });
        if (raw === undefined) return undefined;
        try { forceReturnValue = JSON.parse(raw); }
        catch { forceReturnValue = raw; /* treat as raw string */ }
    }

    let stackCaptureCount: number | undefined;
    if (template === "log-stack") {
        const raw = await vscode.window.showInputBox({
            prompt: "Stack capture count (first N hits, default 5)",
            value: String(initial?.stackCaptureCount ?? 5),
            validateInput: (v) => /^\d+$/.test(v) ? null : "must be a non-negative integer",
        });
        if (raw === undefined) return undefined;
        stackCaptureCount = parseInt(raw, 10);
    }

    return { template, className, methodName, forceReturnValue, stackCaptureCount };
}

export function registerHookCommands(deps: HooksCommandDeps): vscode.Disposable[] {
    const { store, coreApi, openLog } = deps;
    const cmds: vscode.Disposable[] = [];

    cmds.push(vscode.commands.registerCommand("frida.hooks.add", async () => {
        const spec = await pickSpec();
        if (!spec) return;
        const v = validateHookSpec(spec);
        if (!v.ok) { vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`); return; }
        const stored = store.add(spec);
        try {
            await store.install(stored.id);
            vscode.window.showInformationMessage(`Hook installed: ${spec.className}.${spec.methodName}`);
        } catch (err) {
            vscode.window.showWarningMessage(
                `Hook saved but install failed: ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.toggle", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        try {
            if (target.installedHookId === null) await store.install(target.id);
            else await store.uninstall(target.id);
        } catch (err) {
            vscode.window.showErrorMessage(`Toggle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.delete", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        const yes = await vscode.window.showWarningMessage(
            `Delete hook ${target.spec.className}.${target.spec.methodName}?`,
            { modal: true }, "Delete",
        );
        if (yes !== "Delete") return;
        await store.remove(target.id);
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.edit", async (item?: StoredHook) => {
        const target = await resolveTarget(store, item);
        if (!target) return;
        const spec = await pickSpec(target.spec);
        if (!spec) return;
        const v = validateHookSpec(spec);
        if (!v.ok) { vscode.window.showErrorMessage(`Invalid hook: ${v.reason}`); return; }
        try {
            await store.update(target.id, spec);
        } catch (err) {
            vscode.window.showErrorMessage(`Edit failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    let httpModeWarned = false;
    cmds.push(vscode.commands.registerCommand("frida.hooks.openLog", (hookIdFocus?: string) => {
        if (!httpModeWarned) {
            const useDirect = vscode.workspace.getConfiguration("fridaToolkit").get<boolean>("useDirectMode", true);
            if (!useDirect) {
                vscode.window.showWarningMessage(
                    "Hooks plugin: live event stream requires direct Frida mode. Hooks install but log will stay empty in HTTP mode.",
                );
                httpModeWarned = true;
            }
        }
        openLog(hookIdFocus);
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.clearAll", async () => {
        const yes = await vscode.window.showWarningMessage(
            "Uninstall every active hook? Definitions stay on disk.",
            { modal: true }, "Uninstall all",
        );
        if (yes !== "Uninstall all") return;
        try {
            const r = await coreApi.rpc.call<{ count: number }>("clearAllHooks");
            store.markAllDisarmed();
            vscode.window.showInformationMessage(`Uninstalled ${r.count} hooks`);
        } catch (err) {
            vscode.window.showErrorMessage(`clearAll failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }));

    cmds.push(vscode.commands.registerCommand("frida.hooks.addFromMember",
        async (arg1?: any, arg2?: any) => {
            let className: string | undefined;
            let methodName: string | undefined;
            // Two call shapes:
            // 1. Programmatic: (className, methodName) — used when invoked from a different code path.
            // 2. Tree context-menu: (memberNode) — VSCode passes the tree node.
            if (typeof arg1 === "string") {
                className = arg1;
                methodName = typeof arg2 === "string" ? arg2 : undefined;
            } else if (arg1 && typeof arg1 === "object") {
                const node = arg1 as { kind?: string; container?: { className?: string }; obfName?: string; memberKind?: string };
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

            const template = await vscode.window.showQuickPick(
                ["log", "log-stack", "noop"] as const,
                { placeHolder: `Hook ${className}.${methodName} as` },
            );
            if (!template) return;
            const spec = { template, className, methodName } as HookSpec;
            const stored = store.add(spec);
            try {
                await store.install(stored.id);
                vscode.window.showInformationMessage(`Hook installed: ${className}.${methodName}`);
            } catch (err) {
                vscode.window.showWarningMessage(
                    `Hook saved disarmed (install failed): ${err instanceof Error ? err.message : String(err)}`,
                );
            }
        },
    ));

    return cmds;
}

async function resolveTarget(store: HookStore, fromArg: StoredHook | undefined): Promise<StoredHook | undefined> {
    if (fromArg && typeof fromArg === "object" && "id" in fromArg) return fromArg;
    const list = store.list();
    if (list.length === 0) {
        vscode.window.showInformationMessage("No hooks defined yet.");
        return undefined;
    }
    const pick = await vscode.window.showQuickPick(
        list.map((h) => ({
            label: `${h.spec.className}.${h.spec.methodName}`,
            description: `[${h.spec.template}]${h.installedHookId ? " installed" : " disarmed"}`,
            hook: h,
        })),
        { placeHolder: "Pick a hook" },
    );
    return pick?.hook;
}
