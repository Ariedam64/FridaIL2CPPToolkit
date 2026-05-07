// app/frontend/components/class-detail.ts
import { api } from "../core/api.js";
import { icons } from "../core/icons.js";
import { openInstancePicker } from "./instance-picker-modal.js";

interface MethodEntry { isStatic: boolean; returnType: string; name: string; params: string; }
interface FieldEntry { isStatic: boolean; type: string; name: string; }

function escape(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseDump(dump: string): { fields: FieldEntry[]; methods: MethodEntry[] } {
    const lines = dump.split("\n");
    const fields: FieldEntry[] = [];
    const methods: MethodEntry[] = [];
    let mode: "none" | "fields" | "methods" = "none";
    for (const line of lines) {
        if (line.startsWith("**Fields")) { mode = "fields"; continue; }
        if (line.startsWith("**Methods")) { mode = "methods"; continue; }
        if (!line.startsWith("- ")) continue;
        const body = line.slice(2);
        if (mode === "fields") {
            const isStatic = body.startsWith("static ");
            const rest = isStatic ? body.slice(7) : body;
            const sp = rest.indexOf(" ");
            if (sp < 0) continue;
            fields.push({ isStatic, type: rest.slice(0, sp), name: rest.slice(sp + 1) });
        } else if (mode === "methods") {
            const isStatic = body.startsWith("static ");
            const rest = isStatic ? body.slice(7) : body;
            const m = /^(\S+)\s+(\w+)\((.*)\)$/.exec(rest);
            if (m) methods.push({ isStatic, returnType: m[1], name: m[2], params: m[3] });
        }
    }
    return { fields, methods };
}

export interface ClassDetailHandle {
    show(fullName: string): Promise<void>;
}

export function renderClassDetail(host: HTMLElement): ClassDetailHandle {
    host.className = "class-pane";
    host.innerHTML = `<div style="padding:24px;color:var(--text-faint)">Click a class in the explorer to view its detail.</div>`;

    async function show(fullName: string): Promise<void> {
        let liveInstanceCount: number | null = null;  // null = not yet probed, 0 = none, >0 = some
        host.innerHTML = `<div style="padding:24px;color:var(--text-faint)">Loading ${escape(fullName)}…</div>`;
        let dump: string;
        try {
            const { result } = await api.rpc<string>("dumpClassAsString", [fullName]);
            dump = result;
        } catch (e) {
            host.innerHTML = `<div style="padding:24px;color:var(--danger)">Failed: ${escape(String(e))}</div>`;
            return;
        }
        const { fields, methods } = parseDump(dump);
        const lastDot = fullName.lastIndexOf(".");
        const ns = lastDot > 0 ? fullName.slice(0, lastDot) : "";
        const shortName = lastDot > 0 ? fullName.slice(lastDot + 1) : fullName;

        // Get hooks for this class so we can mark hooked methods.
        let hooked = new Set<string>();
        try {
            const { hooks } = await api.getHooks();
            for (const h of hooks) {
                if (h.installedHookId && h.spec.className === fullName) {
                    hooked.add(h.spec.methodName);
                }
            }
        } catch { /* ignore */ }

        const fieldsHtml = fields.map((f) => `
            <div class="member-row">
                <span class="kind-tag field">field</span>
                ${f.isStatic ? '<span class="static-badge">static</span>' : ""}
                <span class="type">${escape(f.type)}</span>
                <span class="name">${escape(f.name)}</span>
                <div class="actions">
                    <button class="icon-btn-mini" data-copy="${escape(fullName)}.${escape(f.name)}">${icons.clipboard()}</button>
                </div>
            </div>
        `).join("");

        const methodsHtml = methods.map((m) => `
            <div class="member-row${hooked.has(m.name) ? " hooked" : ""}" data-method="${escape(m.name)}">
                <span class="kind-tag method">method</span>
                ${m.isStatic ? '<span class="static-badge">static</span>' : ""}
                <span class="ret">${escape(m.returnType)}</span>
                <span class="name">${escape(m.name)}</span>
                <span class="params">(${escape(m.params)})</span>
                <div class="actions">
                    <button class="icon-btn-mini hook-btn" data-method="${escape(m.name)}">${icons.hook()} Hook</button>
                    <button class="icon-btn-mini trace-btn" data-method="${escape(m.name)}">${icons.crosshair()} Trace</button>
                    <button class="icon-btn-mini netadd-btn" data-method="${escape(m.name)}" title="Add to Network plugin">${icons.network()} Net</button>
                    <button class="icon-btn-mini" data-copy="${escape(fullName)}.${escape(m.name)}(${escape(m.params)})">${icons.clipboard()}</button>
                </div>
            </div>
        `).join("");

        host.innerHTML = `
            <div class="breadcrumb">
                ${ns.split(".").map((p, i, arr) => `<span class="crumb ${i === arr.length - 1 ? "last" : ""}">${escape(p)}</span>`).join('<span class="sep">›</span>')}
                ${ns ? '<span class="sep">›</span>' : ""}
                <span class="crumb last">${escape(shortName)}</span>
            </div>
            <div class="class-header">
                <h1>${escape(shortName)}</h1>
                <span class="badge-tag">${escape(fullName)}</span>
                <div class="actions">
                    <button class="pill" id="cd-bookmark">${icons.star()}</button>
                    <button class="pill" id="cd-note">${icons.note()} Note</button>
                    <button class="pill" id="cd-copy-obf">${icons.clipboard()} Copy</button>
                    <button class="pill" id="cd-instances">${icons.crosshair()} Instances</button>
                    <button class="pill primary" id="cd-rename">${icons.pencil()} Rename</button>
                </div>
            </div>
            <div class="member-filter-pill filter-pill">
                <span style="color:var(--text-faint)">${icons.search()}</span>
                <input id="cd-filter" placeholder="Filter members…">
            </div>
            <div class="class-content">
                <div class="section-h">Fields <span class="count-badge">${fields.length}</span></div>
                ${fieldsHtml || '<div style="color:var(--text-faint);padding:8px 12px">No fields.</div>'}
                <div class="section-h" style="margin-top:20px">Methods <span class="count-badge">${methods.length}</span></div>
                ${methodsHtml || '<div style="color:var(--text-faint);padding:8px 12px">No methods.</div>'}
            </div>
        `;

        // Wire actions
        host.querySelectorAll<HTMLButtonElement>(".hook-btn").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const methodName = b.dataset.method!;
                const template = await pickTemplate();
                if (!template) return;
                try {
                    const { stored } = await api.addHook({ template, className: fullName, methodName });
                    await api.installHook(stored.id);
                } catch (e) {
                    alert(`Hook install failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
        });
        host.querySelectorAll<HTMLButtonElement>(".trace-btn").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const methodName = b.dataset.method!;
                try {
                    const { stored } = await api.addHook({
                        template: "log-stack",
                        className: fullName,
                        methodName,
                        stackCaptureCount: 5,
                    });
                    await api.installHook(stored.id);
                } catch (e) {
                    alert(`Trace install failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
        });
        host.querySelectorAll<HTMLButtonElement>(".netadd-btn").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                const methodName = b.dataset.method!;
                const dir = window.prompt("Direction (send / recv)?", "send");
                if (!dir || (dir !== "send" && dir !== "recv")) return;
                try {
                    // Validate first to get the canonical signature.
                    const validation = await api.rpc<{ valid: boolean; reason?: string; actualSignature?: string }>(
                        "validateSerializerEntry",
                        [{
                            source: "manual",
                            direction: dir as "send" | "recv",
                            ns: ns || null,
                            className: shortName,
                            methodName,
                            methodSignature: "",
                            paramIndex: 0,
                            addedAt: new Date().toISOString(),
                        }],
                    );
                    if (!validation.result.valid) {
                        alert(`Cannot add to Network: ${validation.result.reason ?? "unknown"}`);
                        return;
                    }
                    // Fetch existing config, append, save.
                    const cfg = await api.getSerializerConfig();
                    const newEntry = {
                        source: "manual" as const,
                        direction: dir as "send" | "recv",
                        ns: ns || null,
                        className: shortName,
                        methodName,
                        methodSignature: validation.result.actualSignature ?? "",
                        paramIndex: 0,
                        addedAt: new Date().toISOString(),
                    };
                    await api.putSerializerConfig([...cfg.config.entries, newEntry]);
                    alert(`Added to Network plugin: ${dir} ${shortName}.${methodName}\nGo to Network → Configure to enable & start.`);
                } catch (e) {
                    alert(`Add to Network failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            });
        });
        host.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((b) => {
            b.addEventListener("click", async (ev) => {
                ev.stopPropagation();
                await navigator.clipboard.writeText(b.dataset.copy!);
            });
        });
        host.querySelector<HTMLInputElement>("#cd-filter")?.addEventListener("input", (ev) => {
            const q = (ev.target as HTMLInputElement).value.toLowerCase();
            host.querySelectorAll<HTMLElement>(".member-row").forEach((row) => {
                const name = row.querySelector<HTMLElement>(".name")?.textContent?.toLowerCase() ?? "";
                row.style.display = (q === "" || name.includes(q)) ? "" : "none";
            });
        });
        host.querySelector("#cd-bookmark")?.addEventListener("click", async () => {
            await api.toggleBookmark({ kind: "class", className: fullName });
        });
        host.querySelector("#cd-rename")?.addEventListener("click", async () => {
            const labels = await api.getLabels();
            const current = labels.classes[fullName]?.label ?? "";
            const next = prompt(`Rename ${fullName} →`, current);
            if (next === null) return;
            if (next === "") await api.removeLabel("class", { className: fullName });
            else await api.setLabel("class", { className: fullName }, next);
        });
        host.querySelector("#cd-note")?.addEventListener("click", async () => {
            const annotations = await api.getAnnotations();
            const current = annotations.notes.find((n: any) => n.key.className === fullName)?.markdown ?? "";
            const next = prompt(`Note for ${shortName} (markdown)`, current);
            if (next === null) return;
            if (next === "") await api.removeNote({ kind: "class", className: fullName });
            else await api.setNote({ kind: "class", className: fullName }, next);
        });
        host.querySelector("#cd-copy-obf")?.addEventListener("click", () => {
            void navigator.clipboard.writeText(fullName);
        });
        host.querySelector("#cd-instances")?.addEventListener("click", () => {
            const btn = host.querySelector<HTMLButtonElement>("#cd-instances");
            const instances: string[] = btn?.dataset.instances ? JSON.parse(btn.dataset.instances) : [];
            if (liveInstanceCount === 1 || instances.length === 1) {
                // Single instance: auto-capture, no friction.
                location.hash = `#/instances?class=${encodeURIComponent(fullName)}&auto=1`;
            } else if (liveInstanceCount && liveInstanceCount > 1 && instances.length > 1) {
                // Multiple: show picker modal.
                openInstancePicker(fullName, instances);
            } else {
                // No live instances (0) or probe failed — open wizard so user can pick captureViaHook.
                location.hash = `#/instances?class=${encodeURIComponent(fullName)}`;
            }
        });

        // Probe live instance count for the Instances button.
        void (async () => {
            try {
                const { result } = await api.rpc<string[]>("listInstances", [fullName, 20]);
                const btn = host.querySelector<HTMLButtonElement>("#cd-instances");
                if (!btn) return;
                // Parse the agent's response. It returns either
                //   [`[0] Class@handle`, optionally `… and N more (total M)`]
                // or [`(none — try captureViaHook for MonoBehaviours)`] when empty.
                const lines = result;
                const isEmpty = lines.length === 0 || (lines.length === 1 && lines[0].includes("(none"));
                if (isEmpty) {
                    liveInstanceCount = 0;
                    btn.innerHTML = `${icons.crosshair()} Instances <span style="color:var(--text-faint);font-size:10px">(none)</span>`;
                    btn.title = "GC found no live instances — try via Hook on a tick method";
                } else {
                    // Count `[N] …` lines; use the "total M" trailer when truncated.
                    const instanceLines = lines.filter((l) => /^\[\d+\] /.test(l));
                    const totalMatch = lines.join(" ").match(/total (\d+)/);
                    const count = totalMatch ? parseInt(totalMatch[1], 10) : instanceLines.length;
                    const isTruncated = !!totalMatch;
                    liveInstanceCount = count;
                    btn.innerHTML = `${icons.crosshair()} Instances <span style="color:var(--success);font-size:10px">(${count}${isTruncated ? "+" : ""} live)</span>`;
                    btn.title = `${count}${isTruncated ? "+" : ""} live instance${count === 1 ? "" : "s"} via GC — click to ${count === 1 ? "capture" : "pick"}`;
                    btn.dataset.instances = JSON.stringify(instanceLines);
                }
                // (instanceLines already stored inside the else branch above)
            } catch {
                // Probe failed (no session, agent disconnected, etc.) — keep default label.
            }
        })();
    }

    return { show };
}

async function pickTemplate(): Promise<"log" | "log-stack" | "noop" | null> {
    const choice = prompt("Hook template (log / log-stack / noop):", "log");
    if (!choice) return null;
    if (choice === "log" || choice === "log-stack" || choice === "noop") return choice;
    alert("Invalid template");
    return null;
}
