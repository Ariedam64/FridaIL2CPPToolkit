// Instance panel — capture, read/write fields, call methods, list operations.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine, logRpcResult } from "./logs.js";
import { addWatchlistPin } from "./watchlist.js";

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
    } catch (err) {
        logRpcLine(`[rpc] ${action} failed: ${String(err)}`);
    }
}

function section(title: string): string {
    return `<div class="section-header" style="margin-top:var(--s-2)">${title}</div>`;
}

function row(content: string): string {
    return `<div class="action-row" style="display:flex; gap:var(--s-2); flex-wrap:wrap">${content}</div>`;
}

function inp(arg: string, placeholder: string, width = "1"): string {
    return `<input class="input" data-arg="${arg}" placeholder="${placeholder}" style="flex:${width}; min-width:80px">`;
}

function btn(action: string, label: string, primary = false): string {
    return `<button class="btn${primary ? " primary" : ""}" data-action="${action}">${label}</button>`;
}

export function renderInstance(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-3); padding:var(--s-3)">

        ${section("list instances (GC scan)")}
        ${row(inp("className", "class name") + inp("max", "max (20)", "0.4") + btn("listInstances", "list"))}

        ${section("capture via GC")}
        ${row(inp("className", "class name") + inp("index", "index (0)", "0.4") + btn("captureViaGC", "capture"))}

        ${section("capture via hook")}
        ${row(inp("className", "class name") + inp("tickMethod", "tick method") + btn("capture", "hook-capture"))}

        ${section("list captured")}
        ${row(btn("listCaptured", "list captured", true))}

        ${section("dump instance")}
        ${row(inp("className", "class name") + btn("dumpInstance", "dump"))}

        ${section("read field")}
        ${row(inp("className", "class name") + inp("fieldName", "field name") + btn("readField", "read") + btn("pinField", "📌 pin instance"))}

        ${section("pin static field")}
        ${row(inp("className", "class name") + inp("fieldName", "field name") + btn("pinStaticField", "📌 pin static"))}

        ${section("write field")}
        ${row(inp("className", "class name") + inp("fieldName", "field name") + inp("value", "value") + btn("writeField", "write"))}

        ${section("call instance method")}
        ${row(inp("className", "class name") + inp("methodName", "method name") + inp("args", '[] or ["a",1]') + btn("callInstance", "call"))}

        ${section("read list field")}
        ${row(inp("className", "class name") + inp("fieldName", "field name") + inp("limit", "50", "0.4") + btn("readList", "read"))}

        ${section("enumerate list elements")}
        ${row(inp("className", "class name") + inp("fieldName", "field name") + inp("methods", "methods (csv)") + inp("limit", "50", "0.4") + btn("enumerateList", "enumerate"))}

        ${section("capture list element")}
        ${row(inp("listClassName", "list class") + inp("listFieldName", "list field") + inp("index", "index (0)", "0.4") + inp("asKey", "as-key name") + btn("captureListElement", "capture elem"))}

      </div>
    `;

    container.addEventListener("click", (e) => {
        const btnEl = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btnEl || !btnEl.dataset.action) return;
        const action = btnEl.dataset.action;
        const rowEl  = btnEl.closest(".action-row") as HTMLElement | null;
        const inputs = rowEl
            ? [...rowEl.querySelectorAll<HTMLInputElement>("[data-arg]")]
            : [];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });

        // Pin actions handled specially — they update the watchlist panel on success
        if (action === "pinField" || action === "pinStaticField") {
            void runPinAction(action, vals);
            return;
        }

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

async function runPinAction(action: string, v: Record<string, string>): Promise<void> {
    const kind = action === "pinStaticField" ? "static" : "instance";
    const className = v["className"] ?? "";
    const fieldName = v["fieldName"] ?? "";
    if (!className || !fieldName) {
        logRpcLine(`[rpc] ${action}: class name and field name are required`);
        return;
    }
    logRpcLine(`[rpc] pinField("${kind}", "${className}", "${fieldName}")`);
    try {
        const result = await rpcCall<{ id: string; label: string }>("pinField", [kind, className, fieldName]);
        logRpcLine(`[rpc] pinned → ${result.id} (${result.label})`);
        addWatchlistPin(result.id, result.label);
    } catch (err) {
        logRpcLine(`[rpc] pinField failed: ${String(err)}`);
    }
}

function buildArgs(action: string, v: Record<string, string>): unknown[] {
    switch (action) {
        case "listInstances":
            return [v["className"], parseInt(v["max"] || "20", 10)];
        case "captureViaGC":
            return [v["className"], parseInt(v["index"] || "0", 10)];
        case "capture":
            return [v["className"], v["tickMethod"]];
        case "listCaptured":
            return [];
        case "dumpInstance":
            return [v["className"]];
        case "readField":
            return [v["className"], v["fieldName"]];
        case "writeField":
            return [v["className"], v["fieldName"], parseVal(v["value"] ?? "")];
        case "callInstance": {
            let args: unknown[] = [];
            try { args = JSON.parse(v["args"] || "[]") as unknown[]; }
            catch (e) { throw new Error("invalid JSON for args: " + String(e)); }
            return [v["className"], v["methodName"], args];
        }
        case "readList":
            return [v["className"], v["fieldName"], parseInt(v["limit"] || "50", 10)];
        case "enumerateList": {
            const methods = (v["methods"] || "").split(",").map(s => s.trim()).filter(Boolean);
            return [v["className"], v["fieldName"], methods, parseInt(v["limit"] || "50", 10)];
        }
        case "captureListElement":
            return [v["listClassName"], v["listFieldName"], parseInt(v["index"] || "0", 10), v["asKey"]];
        default:
            return Object.values(v);
    }
}
