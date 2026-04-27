// Search panel — find classes, find by field/method, dump class.
import { rpcCall } from "../lib/rpc.js";
import { logRpcLine, logRpcResult } from "./logs.js";
import { saveDumpToFile } from "../lib/dump-client.js";

function parsePattern(v: string): string | RegExp {
    const m = v.match(/^\/(.+)\/([a-z]*)$/);
    if (m) { try { return new RegExp(m[1], m[2]); } catch { /* fall through */ } }
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

export function renderSearch(container: HTMLElement): void {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:var(--s-4); padding:var(--s-3)">

        <div class="section-header">full analyze</div>
        <div style="display:flex; gap:var(--s-2)">
          <button class="btn primary" data-action="analyze">run analyze</button>
          <span style="color:var(--ink-muted); font-size:11.5px; align-self:center">lists assemblies + classes + MonoBehaviours</span>
        </div>

        <div class="section-header">find by name <span class="meta">regex ok</span></div>
        <div class="action-row" data-section="find" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="pattern" placeholder="Player · /^UI.*/" style="flex:1">
          <button class="btn" data-action="find">find classes</button>
        </div>

        <div class="section-header">find by field <span class="meta">beats obfuscation</span></div>
        <div class="action-row" data-section="findByField" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="typePattern" placeholder="type regex (Int32, Vector3)" style="flex:1">
          <input class="input" data-arg="namePattern" placeholder="name regex (health, gold)" style="flex:1">
          <button class="btn" data-action="findByField">find</button>
        </div>

        <div class="section-header">find by method</div>
        <div class="action-row" data-section="findByMethod" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="returnType" placeholder="return (Boolean)" style="flex:1">
          <input class="input" data-arg="paramType"  placeholder="param (Vector3)"  style="flex:1">
          <input class="input" data-arg="name"       placeholder="name (Damage)"    style="flex:1">
          <button class="btn" data-action="findByMethod">find</button>
        </div>

        <div class="section-header">string in memory</div>
        <div class="action-row" data-section="findStringInMemory" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="text" placeholder='literal (e.g. "Game Over")' style="flex:1">
          <button class="btn" data-action="findStringInMemory">scan</button>
        </div>

        <div class="section-header">dump class</div>
        <div class="action-row" data-section="dump" style="display:flex; gap:var(--s-2)">
          <input class="input" data-arg="name" placeholder="exact class name" style="flex:1">
          <button class="btn" data-action="dumpClass">full</button>
          <button class="btn" data-action="dumpStatics">statics</button>
          <button class="btn" data-action="dumpClassToFile">dump to file</button>
        </div>

      </div>
    `;

    // Listen for dump-class events triggered by clicking class links in logs
    const dumpInput = container.querySelector<HTMLInputElement>('[data-section="dump"] [data-arg="name"]');
    document.addEventListener("dump-class", (e) => {
        const detail = (e as CustomEvent).detail as { name: string; action: string };
        if (dumpInput) dumpInput.value = detail.name;
        void runAction(detail.action, [detail.name]);
    });

    container.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
        if (!btn || !btn.dataset.action) return;
        const action = btn.dataset.action;
        const section = btn.closest(".action-row") as HTMLElement | null;
        const inputs = section
            ? [...section.querySelectorAll<HTMLInputElement>("[data-arg]")]
            : [...container.querySelectorAll<HTMLInputElement>("[data-arg]")];
        const vals: Record<string, string> = {};
        inputs.forEach(i => { vals[i.dataset.arg!] = i.value.trim(); });

        let args: unknown[];
        switch (action) {
            case "analyze":
                args = [];
                break;
            case "find":
                args = [parsePattern(vals["pattern"] ?? ""), 50];
                break;
            case "findByField":
                args = [vals["typePattern"] || null, vals["namePattern"] || null, 50];
                break;
            case "findByMethod":
                args = [{ returnType: vals["returnType"] || undefined, paramType: vals["paramType"] || undefined, name: vals["name"] || undefined }, 50];
                break;
            case "findStringInMemory":
                args = [vals["text"], 10];
                break;
            case "dumpClass":
            case "dumpStatics":
                args = [vals["name"]];
                break;
            case "dumpClassToFile": {
                const className = vals["name"];
                if (!className) { logRpcLine(`[dump] class name required`); return; }
                void (async () => {
                    logRpcLine(`[dump] dumpClassAsString("${className}")`);
                    try {
                        const md = await rpcCall<string>("dumpClassAsString", [className]);
                        await saveDumpToFile(md, { name: className, ext: "md" });
                    } catch (err) {
                        logRpcLine(`[dump] failed: ${String(err)}`);
                    }
                })();
                return;
            }
            default:
                args = Object.values(vals);
        }

        void runAction(action, args);
    });
}
