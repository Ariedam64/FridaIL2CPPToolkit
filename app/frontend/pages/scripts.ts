// app/frontend/pages/scripts.ts
// Frontend page: list scripts (left), param form + console (right).
// WS events `script-list-changed`, `script-log`, `script-result` arrive via the
// shared bridge in main.ts and are dispatched to this host element as
// CustomEvent of the same name.

interface ParamSpec {
    type: "string" | "number" | "boolean" | "enum";
    label?: string; required?: boolean; default?: unknown;
    placeholder?: string; min?: number; max?: number; values?: readonly string[];
}

interface RegistryEntry {
    id: string;
    filePath: string;
    status: "loaded" | "compile-error" | "validation-error";
    definition?: { name: string; description?: string; params: Record<string, ParamSpec>; timeoutMs?: number };
    error?: string;
    loadedAt: string;
}

let scripts: RegistryEntry[] = [];
let selected: string | null = null;

export async function renderScriptsPage(host: HTMLElement): Promise<void> {
    host.innerHTML = `
        <div style="display:flex;height:100%">
            <div data-testid="list" style="width:240px;border-right:1px solid #333;overflow:auto"></div>
            <div data-testid="detail" style="flex:1;display:flex;flex-direction:column"></div>
        </div>
    `;

    await refresh(host);

    // WS event hook-up. main.ts is responsible for dispatching CustomEvents on this host.
    host.addEventListener("script-list-changed", () => { void refresh(host); });
    host.addEventListener("script-log",   ((e: Event) => appendLog(host, (e as CustomEvent).detail)) as EventListener);
    host.addEventListener("script-result", ((e: Event) => appendResult(host, (e as CustomEvent).detail)) as EventListener);
}

export function mountScriptsPage(host: HTMLElement): void {
    void renderScriptsPage(host);
}

async function refresh(host: HTMLElement): Promise<void> {
    const r = await fetch("/api/scripts");
    const data = await r.json() as { scripts: RegistryEntry[] };
    scripts = data.scripts;
    renderList(host);
    if (selected && !scripts.find((s) => s.id === selected)) selected = null;
    if (selected) renderDetail(host, scripts.find((s) => s.id === selected)!);
}

function renderList(host: HTMLElement): void {
    const list = host.querySelector("[data-testid='list']") as HTMLElement;
    list.innerHTML = "";
    for (const s of scripts) {
        const icon = s.status === "loaded" ? "▶" : "⚠";
        const div = document.createElement("div");
        div.setAttribute("data-testid", "script-item");
        div.setAttribute("data-script-id", s.id);
        div.style.cssText = "padding:6px;cursor:pointer;border-bottom:1px solid #222";
        div.textContent = `${icon} ${s.definition?.name ?? s.id}`;
        if (selected === s.id) div.style.background = "#1e3a8a";
        div.addEventListener("click", () => { selected = s.id; renderList(host); renderDetail(host, s); });
        list.appendChild(div);
    }
}

function renderDetail(host: HTMLElement, s: RegistryEntry): void {
    const detail = host.querySelector("[data-testid='detail']") as HTMLElement;
    if (s.status !== "loaded") {
        detail.innerHTML = `
            <div style="padding:12px">
                <h2>${escapeHtml(s.id)}</h2>
                <pre data-testid="script-error" style="color:#f87171;white-space:pre-wrap">${escapeHtml(s.error ?? "unknown error")}</pre>
            </div>
        `;
        return;
    }
    const def = s.definition!;
    const formInputs = Object.entries(def.params).map(([k, spec]) => renderInput(k, spec)).join("");
    detail.innerHTML = `
        <div style="padding:12px;border-bottom:1px solid #333">
            <h2>${escapeHtml(def.name)}</h2>
            <p>${escapeHtml(def.description ?? "")}</p>
            <form data-testid="form">${formInputs}</form>
            <button data-testid="run-btn" style="margin-top:8px">&#9654; Run</button>
        </div>
        <pre data-testid="console" style="flex:1;overflow:auto;margin:0;padding:8px;background:#0a0a0a;color:#cbd5e1;white-space:pre-wrap"></pre>
    `;
    (detail.querySelector("[data-testid='run-btn']") as HTMLButtonElement)
        .addEventListener("click", () => void runSelected(host, s));
}

function renderInput(key: string, spec: ParamSpec): string {
    const label = `<label style="display:block;margin-top:6px">${escapeHtml(spec.label ?? key)}${spec.required ? "*" : ""}</label>`;
    if (spec.type === "boolean") {
        const checked = spec.default ? "checked" : "";
        return `${label}<input data-param="${escapeHtml(key)}" type="checkbox" ${checked}/>`;
    }
    if (spec.type === "enum") {
        const opts = (spec.values ?? []).map((v) => `<option ${v === spec.default ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");
        return `${label}<select data-param="${escapeHtml(key)}">${opts}</select>`;
    }
    const type = spec.type === "number" ? "number" : "text";
    const placeholder = spec.placeholder ? `placeholder="${escapeHtml(spec.placeholder)}"` : "";
    const def = spec.default !== undefined ? `value="${escapeHtml(String(spec.default))}"` : "";
    return `${label}<input data-param="${escapeHtml(key)}" type="${type}" ${placeholder} ${def}/>`;
}

async function runSelected(host: HTMLElement, s: RegistryEntry): Promise<void> {
    const def = s.definition!;
    const params: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(def.params)) {
        const el = host.querySelector(`[data-param="${k}"]`) as HTMLInputElement | HTMLSelectElement | null;
        if (!el) continue;
        if (spec.type === "boolean") params[k] = (el as HTMLInputElement).checked;
        else if (spec.type === "number") {
            const v = (el as HTMLInputElement).value;
            if (v !== "") params[k] = Number(v);
        } else {
            const v = el.value;
            if (v !== "") params[k] = v;
        }
    }
    const r = await fetch(`/api/scripts/${encodeURIComponent(s.id)}/run`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ params }),
    });
    const body = await r.json() as { runId?: string; error?: string };
    if (!r.ok) appendLog(host, { level: "error", args: [body.error ?? "run failed"], ts: new Date().toISOString(), runId: "" });
    else appendLog(host, { level: "info", args: [`▶ Run ${body.runId} started`], ts: new Date().toISOString(), runId: body.runId ?? "" });
}

function appendLog(host: HTMLElement, log: { runId: string; level: string; args: unknown[]; ts: string }): void {
    const c = host.querySelector("[data-testid='console']");
    if (!c) return;
    const ts = (log.ts || new Date().toISOString()).slice(11, 23);
    c.textContent += `${ts} [${log.level}] ${log.args.map(stringify).join(" ")}\n`;
    (c as HTMLElement).scrollTop = (c as HTMLElement).scrollHeight;
}

function appendResult(host: HTMLElement, r: { runId: string; status: string; result?: unknown; error?: { message: string }; durationMs: number }): void {
    const c = host.querySelector("[data-testid='console']");
    if (!c) return;
    const icon = r.status === "ok" ? "✓" : r.status === "timeout" ? "⏱" : "✗";
    const tail = r.status === "ok" ? `result: ${stringify(r.result)}` : `error: ${r.error?.message ?? ""}`;
    c.textContent += `${icon} ${r.status} (${r.durationMs}ms) ${tail}\n`;
}

function stringify(v: unknown): string {
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
