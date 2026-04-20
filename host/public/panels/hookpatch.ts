// Hook & patch panel — hook methods, replace with noop, force-return, patch statics, call static.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine, logRpcResult } from "./logs.js";
import { recordHook, recordPatch } from "../lib/session.js";

function parseVal(v: string): unknown {
    if (v === "" || v == null) return undefined;
    if (v === "true")  return true;
    if (v === "false") return false;
    if (v === "null")  return null;
    if (/^-?\d+$/.test(v))      return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    try { return JSON.parse(v); } catch { /* fall through */ }
    return v;
}

async function runAction(action: string, args: unknown[]): Promise<void> {
    const preview = args.map(a => JSON.stringify(a)).join(", ");
    logRpcLine(`[rpc] ${action}(${preview})`);
    try {
        const result = await rpcCall(action, args);
        logRpcResult(action, result);
        // Record to session tracker on success
        if (action === "hook" || action === "replaceNoop") {
            recordHook({ className: String(args[0] ?? ""), methodName: String(args[1] ?? ""), mode: action as "hook" | "replaceNoop" });
        } else if (action === "forceReturn") {
            recordHook({ className: String(args[0] ?? ""), methodName: String(args[1] ?? ""), mode: "forceReturn", value: args[2] });
        } else if (action === "patchStatic") {
            recordPatch({ kind: "static", className: String(args[0] ?? ""), field: String(args[1] ?? ""), value: args[2] });
        }
    } catch (err) {
        logRpcLine(`[rpc] ${action} failed: ${String(err)}`);
    }
}

export function renderHookPatch(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-4); padding:var(--s-3)">

        <div class="section-header">log hook</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="className"  placeholder="class name"  style="flex:1">
          <input class="input" data-arg="methodName" placeholder="method name" style="flex:1">
          <button class="btn primary" data-action="hook">hook</button>
        </div>

        <div class="section-header">replace with noop</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="className"  placeholder="class name"  style="flex:1">
          <input class="input" data-arg="methodName" placeholder="method name" style="flex:1">
          <button class="btn" data-action="replaceNoop">noop</button>
        </div>

        <div class="section-header">force return value</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="className" placeholder="class name"  style="flex:1">
          <input class="input" data-arg="method"    placeholder="method name" style="flex:1">
          <input class="input" data-arg="value"     placeholder="return value (true, 0, …)" style="flex:1">
          <button class="btn" data-action="forceReturn">force</button>
        </div>

        <div class="section-header">patch static field</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="className" placeholder="class name"  style="flex:1">
          <input class="input" data-arg="field"     placeholder="field name"  style="flex:1">
          <input class="input" data-arg="value"     placeholder="new value"   style="flex:1">
          <button class="btn" data-action="patchStatic">patch</button>
        </div>

        <div class="section-header">call static method</div>
        <div class="action-row" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="className" placeholder="class name"  style="flex:1">
          <input class="input" data-arg="method"    placeholder="method name" style="flex:1">
          <input class="input" data-arg="args"      placeholder='[] or [1,"x"]' style="flex:1">
          <button class="btn" data-action="callStatic">call</button>
        </div>

      </div>
    `;

    container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn || !btn.dataset.action) return;
        const action = btn.dataset.action;
        const rowEl  = btn.closest(".action-row") as HTMLElement | null;
        const inputs = rowEl ? [...rowEl.querySelectorAll<HTMLInputElement>("[data-arg]")] : [];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });

        let args: unknown[];
        try {
            args = buildArgs(action, vals);
        } catch (err) {
            logRpcLine(`[rpc] ${action} arg error: ${String(err)}`);
            return;
        }
        void runAction(action, args);
    });
}

function buildArgs(action: string, v: Record<string, string>): unknown[] {
    switch (action) {
        case "hook":
        case "replaceNoop":
            return [v["className"], v["methodName"]];
        case "forceReturn":
            return [v["className"], v["method"], parseVal(v["value"] ?? "")];
        case "patchStatic":
            return [v["className"], v["field"], parseVal(v["value"] ?? "")];
        case "callStatic": {
            let args: unknown[] = [];
            try { args = JSON.parse(v["args"] || "[]") as unknown[]; }
            catch (e) { throw new Error("invalid JSON for args: " + String(e)); }
            return [v["className"], v["method"], args];
        }
        default:
            return Object.values(v);
    }
}
