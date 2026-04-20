/* =============================================================================
 * Frida IL2CPP Toolkit — web UI
 * =============================================================================
 * Talks to host/server.js:
 *   GET  /api/processes            → list local processes
 *   POST /api/attach   {pid}       → attach Frida + load rpc-agent
 *   POST /api/detach               → unload + detach
 *   POST /api/reload               → re-read agent script and re-load
 *   POST /api/call  {method,args}  → proxy to script.exports[method](...args)
 *   WS   /ws                       → broadcast of script messages + state
 * ============================================================================= */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const logEl      = $("#log");
const statusEl   = $("#status");
const procListEl = $("#proclist");
const btnDetach  = $("#btn-detach");
const btnReload  = $("#btn-reload");
let currentPid   = null;

// ---------- logging --------------------------------------------------------
const showFilters = { log: true, hook: true, rpc: true };
function isVisible(cls) {
    if (cls === "log")  return showFilters.log;
    if (cls === "hook") return showFilters.hook;
    if (cls === "rpc")  return showFilters.rpc;
    return true;
}
function log(text, cls = "log") {
    const div = document.createElement("div");
    div.className = "line " + cls;
    div.dataset.cls = cls;
    const ts = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="ts">${ts}</span>`;
    div.appendChild(document.createTextNode(text));
    if (!isVisible(cls)) div.style.display = "none";
    logEl.appendChild(div);
    if ($("#autoscroll").checked) logEl.scrollTop = logEl.scrollHeight;
}

// ---------- log batching: group consecutive console.log lines into blocks --
let logBatch = [];
let logBatchTimer = null;

function pushLogLine(text) {
    logBatch.push(text);
    clearTimeout(logBatchTimer);
    logBatchTimer = setTimeout(flushLogBatch, 120);
}

function flushLogBatch() {
    clearTimeout(logBatchTimer);
    logBatchTimer = null;
    const batch = logBatch;
    logBatch = [];
    if (!batch.length) return;
    if (batch.length === 1) { log(batch[0], "log"); return; }
    renderLogBlock(batch);
}

function escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
}

// span(className, innerText) → safe <span> with escaped text
function hlSpan(cls, text) {
    return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/**
 * Highlight one line of dump output. Returns safely-escaped HTML.
 * Keeps alignment (leading whitespace preserved literally).
 */
function highlightDumpLine(line) {
    // Header: === CLASS/STATICS/etc Something ===
    let m = line.match(/^(=+\s*)(.+?)(\s*=+)$/);
    if (m) {
        return hlSpan("hl-hdr", m[1]) + hlSpan("hl-hdr", m[2]) + hlSpan("hl-hdr", m[3]);
    }

    // "  parent : Foo"
    m = line.match(/^(\s*)(parent)(\s*:\s*)(.*)$/);
    if (m) {
        return escapeHtml(m[1]) + hlSpan("hl-label", m[2]) + escapeHtml(m[3]) + hlSpan("hl-type", m[4]);
    }

    // "  instance fields (6):" / "static fields (1):" / "methods (11):"
    m = line.match(/^(\s*)((?:instance fields|static fields|methods|classes|fields)\s*\([^)]*\))(\s*:\s*)$/);
    if (m) {
        return escapeHtml(m[1]) + hlSpan("hl-label", m[2]) + escapeHtml(m[3]);
    }

    // method line: "    [static ]<returnType> <name>(<params>)"
    //                padding | optional "static " | type | padding | name(args)
    m = line.match(/^(\s*)(static\s+)?(\S+)(\s+)([A-Za-z_][\w.<>`,]*)\(([^)]*)\)(.*)$/);
    if (m) {
        const [, indent, kw, type, pad, name, args, tail] = m;
        return (
            escapeHtml(indent) +
            (kw ? hlSpan("hl-kw", kw.trimEnd()) + escapeHtml(" ") : "") +
            hlSpan("hl-type", type) +
            escapeHtml(pad) +
            hlSpan("hl-method", name) +
            escapeHtml("(") +
            hlSpan("hl-args", args) +
            escapeHtml(")") +
            escapeHtml(tail)
        );
    }

    // field line with value: "    <type>  <name>  = <value>"
    m = line.match(/^(\s*)(\S+)(\s+)(\S+)(\s*=\s*)(.*)$/);
    if (m) {
        const [, indent, type, pad1, name, eq, val] = m;
        return (
            escapeHtml(indent) +
            hlSpan("hl-type", type) +
            escapeHtml(pad1) +
            hlSpan("hl-field", name) +
            escapeHtml(eq) +
            hlSpan("hl-val", val)
        );
    }

    // field declaration (no value): "    <type>  <name>"
    m = line.match(/^(\s*)(\S+)(\s+)(\S+)\s*$/);
    if (m) {
        const [, indent, type, pad, name] = m;
        return escapeHtml(indent) + hlSpan("hl-type", type) + escapeHtml(pad) + hlSpan("hl-field", name);
    }

    return escapeHtml(line);
}

function highlightDump(text) {
    return text.split("\n").map(highlightDumpLine).join("\n");
}

function renderLogBlock(lines) {
    const wrap = document.createElement("div");
    wrap.className = "line log block";
    wrap.dataset.cls = "log";

    // detect a meaningful title from first non-empty line
    const firstReal = lines.find(l => /=== /.test(l)) || "";
    const titleMatch = firstReal.match(/=+\s*(.+?)\s*=+$/);
    const title = titleMatch ? titleMatch[1] : `output · ${lines.length} lines`;

    const header = document.createElement("div");
    header.className = "block-header";

    const toggle = document.createElement("span");
    toggle.className = "block-toggle";
    toggle.textContent = "▾";

    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = new Date().toLocaleTimeString();

    const titleEl = document.createElement("span");
    titleEl.className = "block-title";
    titleEl.textContent = title;

    const count = document.createElement("span");
    count.className = "block-count";
    count.textContent = `${lines.length} lines`;

    header.appendChild(toggle);
    header.appendChild(ts);
    header.appendChild(titleEl);
    header.appendChild(count);

    const pre = document.createElement("pre");
    pre.className = "block-content";
    pre.innerHTML = highlightDump(lines.join("\n"));

    // auto-collapse very long blocks (> 40 lines)
    if (lines.length > 40) {
        pre.classList.add("collapsed");
        toggle.textContent = "▸";
    }

    const toggleFn = () => {
        const collapsed = pre.classList.toggle("collapsed");
        toggle.textContent = collapsed ? "▸" : "▾";
    };
    header.addEventListener("click", toggleFn);

    wrap.appendChild(header);
    wrap.appendChild(pre);

    if (!isVisible("log")) wrap.style.display = "none";
    logEl.appendChild(wrap);
    if ($("#autoscroll").checked) logEl.scrollTop = logEl.scrollHeight;
}

// ---------- HTTP helper ----------------------------------------------------
async function api(path, opts = {}) {
    const res = await fetch(path, {
        headers: { "Content-Type": "application/json" },
        ...opts,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
}

// ---------- process picker -------------------------------------------------
async function loadProcs() {
    const q = $("#q").value.trim();
    const url = q ? `/api/processes?q=${encodeURIComponent(q)}` : "/api/processes";
    procListEl.textContent = "loading…";
    try {
        const procs = await api(url);
        procListEl.innerHTML = "";
        if (procs.length === 0) { procListEl.textContent = "(no match)"; return; }
        for (const p of procs) {
            const row = document.createElement("div");
            row.className = "proc" + (p.pid === currentPid ? " current" : "");
            row.innerHTML = `<span class="pid">${p.pid}</span><span class="name"></span>`;
            row.querySelector(".name").textContent = p.name;
            const btn = document.createElement("button");
            btn.textContent = p.pid === currentPid ? "attached" : "attach";
            btn.disabled = p.pid === currentPid;
            btn.onclick = () => attachTo(p.pid, p.name);
            row.appendChild(btn);
            procListEl.appendChild(row);
        }
    } catch (e) {
        procListEl.textContent = "error: " + e.message;
    }
}

async function attachTo(pid, name) {
    log(`[host] attaching to ${name} (${pid})…`, "host");
    try {
        await api("/api/attach", { method: "POST", body: JSON.stringify({ pid }) });
    } catch (e) {
        log(`[host] attach failed: ${e.message}`, "err");
    }
}

async function doDetach() {
    try { await api("/api/detach", { method: "POST" }); }
    catch (e) { log(`[host] detach failed: ${e.message}`, "err"); }
}

async function doReload() {
    log(`[host] reloading agent…`, "host");
    try { await api("/api/reload", { method: "POST" }); }
    catch (e) { log(`[host] reload failed: ${e.message}`, "err"); }
}

// ---------- action dispatch ------------------------------------------------
function parseVal(v) {
    if (v === "" || v == null)   return undefined;
    if (v === "true")            return true;
    if (v === "false")           return false;
    if (v === "null")            return null;
    if (/^-?\d+$/.test(v))       return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v))  return parseFloat(v);
    try { return JSON.parse(v); } catch {}
    return v;
}

function parsePattern(v) {
    const m = v.match(/^\/(.+)\/([a-z]*)$/);
    if (m) { try { return new RegExp(m[1], m[2]); } catch {} }
    return v;
}

function buildArgs(action, payload) {
    switch (action) {
        case "analyze":      return [];
        case "find":         return [parsePattern(payload.pattern), 50];
        case "dumpClass":    return [payload.name];
        case "dumpStatics":  return [payload.name];
        case "hook":
        case "replaceNoop":  return [payload.className, payload.methodName];
        case "patchStatic":  return [payload.className, payload.field, parseVal(payload.value)];
        case "forceReturn":  return [payload.className, payload.method, parseVal(payload.value)];
        case "callStatic": {
            let args = [];
            try { args = JSON.parse(payload.args || "[]"); }
            catch (e) { throw new Error("invalid JSON for args: " + e.message); }
            return [payload.className, payload.method, args];
        }
        case "capture":       return [payload.className, payload.tickMethod];
        case "listInstances": return [payload.className, 20];
        case "captureViaGC":  return [payload.className, parseInt(payload.index || "0", 10)];
        case "listCaptured":  return [];
        case "dumpInstance":  return [payload.className];
        case "readField":     return [payload.className, payload.fieldName];
        case "writeField":    return [payload.className, payload.fieldName, parseVal(payload.value)];
        case "callInstance": {
            let args = [];
            try { args = JSON.parse(payload.args || "[]"); }
            catch (e) { throw new Error("invalid JSON for args: " + e.message); }
            return [payload.className, payload.methodName, args];
        }
        case "findByField":  return [payload.typePattern || null, payload.namePattern || null, 50];
        case "findByMethod": return [{
            returnType: payload.returnType || undefined,
            paramType:  payload.paramType  || undefined,
            name:       payload.name       || undefined,
        }, 50];
        case "findStringInMemory": return [payload.text, 10];
        case "startNetworkCapture": return [payload.sendClass || "ecu", payload.sendMethod || "xbe"];
        case "stopNetworkCapture":  return [payload.sendClass || "ecu", payload.sendMethod || "xbe"];
        case "readList":           return [payload.className, payload.fieldName, parseInt(payload.limit || "50", 10)];
        case "enumerateList": {
            const methods = (payload.methods || "").split(",").map(s => s.trim()).filter(Boolean);
            return [payload.className, payload.fieldName, methods, parseInt(payload.limit || "50", 10)];
        }
        case "captureListElement":
            return [payload.listClassName, payload.listFieldName, parseInt(payload.index || "0", 10), payload.asKey];
        default: return [];
    }
}

function logClassItem(name) {
    const div = document.createElement("div");
    div.className = "line rpc";
    div.dataset.cls = "rpc";
    const ts = new Date().toLocaleTimeString();
    div.innerHTML = `<span class="ts">${ts}</span>        · `;
    const link = document.createElement("a");
    link.href = "#";
    link.className = "classlink";
    link.textContent = name;
    link.title = "click: dump · shift+click: dump statics";
    link.onclick = (ev) => {
        ev.preventDefault();
        const action = ev.shiftKey ? "dumpStatics" : "dumpClass";
        const inp = document.querySelector(`[data-action="${action}"]`)
            .closest(".action").querySelector('[data-arg="name"]');
        if (inp) inp.value = name;
        callAction(action, { name });
    };
    div.appendChild(link);
    if (!isVisible("rpc")) div.style.display = "none";
    logEl.appendChild(div);
    if ($("#autoscroll").checked) logEl.scrollTop = logEl.scrollHeight;
}

function logResult(action, result) {
    if (result === undefined || result === null) return;
    if (Array.isArray(result)) {
        if (result.length === 0) { log(`[rpc]   → [] (empty)`, "rpc"); return; }
        log(`[rpc]   → [${result.length} items]`, "rpc");
        for (const item of result) {
            if (action === "find" && typeof item === "string") {
                logClassItem(item);
            } else {
                const s = typeof item === "string" ? item : JSON.stringify(item);
                log(`        · ${s}`, "rpc");
            }
        }
        return;
    }
    if (typeof result === "object") {
        const pretty = JSON.stringify(result, null, 2);
        for (const line of pretty.split("\n")) log(`        ${line}`, "rpc");
        return;
    }
    const s = typeof result === "string" ? result : String(result);
    log(`[rpc]   → ${s}`, "rpc");
}

async function callAction(action, payload) {
    try {
        const args = buildArgs(action, payload);
        const argsPreview = args.map(a => JSON.stringify(a)).join(", ");
        log(`[rpc] ${action}(${argsPreview})`, "rpc");
        const { result } = await api("/api/call", {
            method: "POST",
            body: JSON.stringify({ method: action, args }),
        });
        logResult(action, result);
    } catch (e) {
        log(`[rpc] ${action} failed: ${e.message}`, "err");
    }
}

// Wire up every button with data-action
$$("[data-action]").forEach(btn => {
    btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const payload = {};
        const panel = btn.closest(".action");
        $$("[data-arg]", panel).forEach(inp => payload[inp.dataset.arg] = inp.value.trim());
        callAction(action, payload);
    });
});

// ---------- websocket ------------------------------------------------------
function connectWS() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen    = () => log(`[host] ws connected`, "ok");
    ws.onclose   = () => { log(`[host] ws disconnected, retrying…`, "err"); setTimeout(connectWS, 1000); };
    ws.onerror   = () => {};
    ws.onmessage = (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "hello") {
            setAttached(msg.attached);
        } else if (msg.type === "attached") {
            setAttached({ pid: msg.pid, name: msg.name });
            log(`[host] attached to ${msg.name} (${msg.pid})`, "ok");
        } else if (msg.type === "detached") {
            setAttached(null);
            log(`[host] detached${msg.reason ? ` (${msg.reason})` : ""}`, "host");
        } else if (msg.type === "message") {
            handleScriptMessage(msg.message);
        }
    };
}

function handleScriptMessage(m) {
    if (m.type === "log") {
        pushLogLine(m.payload);
        return;
    }
    // any non-log message: flush pending logs first so order is preserved
    flushLogBatch();
    if (m.type === "send") {
        const p = m.payload;
        if (!p || typeof p !== "object") { log(String(p), "log"); return; }
        if (p.type === "hook") {
            const argsStr = (p.args || []).join(", ");
            const ret = p.error ? `THREW ${p.error}` : `→ ${p.retval}`;
            log(`${p.cls}.${p.method}(${argsStr}) ${ret}  [${p.self || "static"}]`, "hook");
        } else if (p.type === "socket") {
            pushSocketEvent(p);
        } else if (p.type === "agent-ready") {
            log(`[agent] ready`, "ok");
        } else {
            log(JSON.stringify(p), "log");
        }
    } else if (m.type === "error") {
        const stack = m.stack ? `\n${m.stack}` : "";
        log(`[script-error] ${m.description || m.fileName || JSON.stringify(m)}${stack}`, "err");
    }
}

function setAttached(info) {
    if (info && info.pid) {
        currentPid = info.pid;
        statusEl.textContent = `attached: ${info.name} (${info.pid})`;
        statusEl.className = "status on";
        btnDetach.disabled = false;
        btnReload.disabled = false;
    } else {
        currentPid = null;
        statusEl.textContent = "not attached";
        statusEl.className = "status off";
        btnDetach.disabled = true;
        btnReload.disabled = true;
    }
    loadProcs();
    const treeEl2 = document.querySelector("#tree");
    if (treeEl2) {
        if (!info) {
            treeEl2.textContent = "(attach a process first)";
        } else if (document.querySelector("#tab-explorer").classList.contains("active")) {
            loadExplorer();
        }
    }
}

// ---------- event wiring ---------------------------------------------------
$("#btn-refresh").onclick = loadProcs;
$("#btn-clear").onclick   = () => { flushLogBatch(); logEl.innerHTML = ""; };
btnDetach.onclick         = doDetach;
btnReload.onclick         = doReload;

let searchTimer = null;
$("#q").oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadProcs, 200);
};

for (const kind of ["log", "hook", "rpc"]) {
    $("#show-" + kind).addEventListener("change", (ev) => {
        showFilters[kind] = ev.target.checked;
        $$(".line").forEach(line => {
            if (line.dataset.cls === kind) {
                line.style.display = ev.target.checked ? "" : "none";
            }
        });
    });
}

// ===========================================================================
// TABS (independent groups: left sidebar, actions panel)
// ===========================================================================
$$(".tabs").forEach(group => {
    const container = group.parentElement;
    group.querySelectorAll(".tab").forEach(t => {
        t.addEventListener("click", () => {
            // toggle within this group only
            group.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
            container.querySelectorAll(":scope > .tab-content").forEach(c =>
                c.classList.toggle("active", c.id === `tab-${t.dataset.tab}`)
            );
            if (t.dataset.tab === "explorer" && currentPid) loadExplorer();
        });
    });
});

// ===========================================================================
// EXPLORER (class tree)
// ===========================================================================
const treeEl = $("#tree");

async function rpcCall(method, args = []) {
    const { result } = await api("/api/call", {
        method: "POST",
        body: JSON.stringify({ method, args }),
    });
    return result;
}

function makeNode({ label, meta, klass, expandable, onExpand, onClick }) {
    const li = document.createElement("li");
    const node = document.createElement("div");
    node.className = "node" + (klass ? " " + klass : "");

    const caret = document.createElement("span");
    caret.className = "caret" + (expandable ? " expandable" : "");

    const lbl = document.createElement("span");
    lbl.className = "label";
    lbl.textContent = label;
    lbl.dataset.label = label.toLowerCase();

    const metaEl = document.createElement("span");
    metaEl.className = "meta";
    if (meta != null) metaEl.textContent = meta;

    node.appendChild(caret);
    node.appendChild(lbl);
    if (meta != null) node.appendChild(metaEl);
    li.appendChild(node);

    let loaded = false;
    let childrenEl = null;

    node.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        if (!expandable && onClick) { onClick(ev); return; }
        if (expandable) {
            if (node.classList.contains("open")) {
                node.classList.remove("open");
                if (childrenEl) childrenEl.style.display = "none";
                return;
            }
            node.classList.add("open");
            if (!loaded) {
                loaded = true;
                const originalMeta = metaEl.textContent;
                metaEl.textContent = "loading…";
                try {
                    childrenEl = await onExpand();
                    if (childrenEl) li.appendChild(childrenEl);
                    metaEl.textContent = originalMeta || "";
                } catch (e) {
                    metaEl.textContent = "error: " + (e.message || e);
                    node.classList.remove("open");
                }
            } else if (childrenEl) {
                childrenEl.style.display = "";
            }
        }
        // expandable+onClick: shift-click to dump without expanding
        if (expandable && onClick && ev.shiftKey) onClick(ev);
    });

    return li;
}

/**
 * Clic sur une classe dans le tree :
 * - remplit TOUS les inputs `className` / `name` visibles dans le tab actif
 * - switch au tab Search et lance un dumpClass (pour voir la structure)
 */
function dumpFromTree(fullName) {
    // fill every class-name-ish input currently in the DOM (visible or not)
    $$('[data-arg="className"], [data-arg="name"]').forEach(inp => { inp.value = fullName; });
    // switch to search tab and trigger dump for immediate feedback
    const searchTab = document.querySelector('.actions-panel .tab[data-tab="search"]');
    if (searchTab && !searchTab.classList.contains("active")) searchTab.click();
    callAction("dumpClass", { name: fullName });
}

async function loadExplorer() {
    const mode = $("#explorer-mode").value;
    $("#inheritance-root-row").style.display = mode === "inheritance" ? "" : "none";
    treeEl.innerHTML = "loading…";
    try {
        const rootUl = document.createElement("ul");
        rootUl.className = "children";
        rootUl.style.marginLeft = "0";
        rootUl.style.borderLeft = "none";

        if (mode === "assembly") {
            const asms = await rpcCall("listAssembliesInfo", []);
            for (const a of asms) {
                rootUl.appendChild(makeNode({
                    label: a.name,
                    meta: `${a.classes}`,
                    klass: "asm",
                    expandable: true,
                    onExpand: async () => {
                        const ul = document.createElement("ul");
                        ul.className = "children";
                        const namespaces = await rpcCall("listNamespaces", [a.name]);
                        for (const nsInfo of namespaces) {
                            ul.appendChild(makeNode({
                                label: nsInfo.ns,
                                meta: `${nsInfo.classes}`,
                                klass: "ns",
                                expandable: true,
                                onExpand: async () => {
                                    const ul2 = document.createElement("ul");
                                    ul2.className = "children";
                                    const classes = await rpcCall("listClassesIn", [a.name, nsInfo.ns]);
                                    for (const cls of classes) {
                                        const fullName = nsInfo.ns === "(root)" ? cls : `${nsInfo.ns}.${cls}`;
                                        ul2.appendChild(makeNode({
                                            label: cls,
                                            klass: "cls",
                                            expandable: false,
                                            onClick: () => dumpFromTree(fullName),
                                        }));
                                    }
                                    return ul2;
                                },
                            }));
                        }
                        return ul;
                    },
                }));
            }
        } else if (mode === "inheritance") {
            const root = $("#inheritance-root").value.trim() || "UnityEngine.MonoBehaviour";
            rootUl.appendChild(await buildInheritanceNode(root));
        }
        treeEl.innerHTML = "";
        treeEl.appendChild(rootUl);
    } catch (e) {
        treeEl.textContent = "error: " + (e.message || e);
    }
}

async function buildInheritanceNode(baseName) {
    return makeNode({
        label: baseName,
        klass: "cls",
        expandable: true,
        onClick: () => dumpFromTree(baseName),
        onExpand: async () => {
            const ul = document.createElement("ul");
            ul.className = "children";
            const subs = await rpcCall("listSubclasses", [baseName, 500]);
            if (!subs.length) {
                const empty = document.createElement("li");
                empty.innerHTML = `<div class="node"><span class="caret"></span><span class="label" style="color:#71717a;font-style:italic">(no direct subclass)</span></div>`;
                ul.appendChild(empty);
                return ul;
            }
            for (const sub of subs) {
                ul.appendChild(await buildInheritanceNode(sub));
            }
            return ul;
        },
    });
}

function applyTreeFilter(q) {
    const lower = q.toLowerCase();
    $$("#tree li").forEach(li => {
        if (!lower) { li.classList.remove("filtered-out"); return; }
        const lbl = li.querySelector(":scope > .node > .label");
        const match = lbl && lbl.dataset.label && lbl.dataset.label.includes(lower);
        // a node is visible if it matches OR any descendant matches
        const hasMatch = match || !!li.querySelector(`.label[data-label*="${CSS.escape(lower)}"]`);
        li.classList.toggle("filtered-out", !hasMatch);
    });
}

$("#explorer-mode").addEventListener("change", loadExplorer);
$("#btn-tree-reload").addEventListener("click", loadExplorer);
$("#btn-inherit-go").addEventListener("click", loadExplorer);
let treeFilterTimer = null;
$("#tree-filter").addEventListener("input", (ev) => {
    clearTimeout(treeFilterTimer);
    treeFilterTimer = setTimeout(() => applyTreeFilter(ev.target.value.trim()), 150);
});

// ===========================================================================
// SOCKET tab — live network traffic
// ===========================================================================
const socketLogEl = $("#socket-log");
let socketFilter = "";
// Manual alias map: obfuscated class name → human-readable name, persisted locally
const socketAliases = (() => {
    try { return JSON.parse(localStorage.getItem("socketAliases") || "{}"); }
    catch { return {}; }
})();
function saveAliases() { localStorage.setItem("socketAliases", JSON.stringify(socketAliases)); }

function pushSocketEvent(p) {
    if (!socketLogEl) return;
    const entry = document.createElement("div");
    entry.className = "socket-entry " + (p.direction || "out");
    entry.dataset.cls = p.cls || "?";
    const ts = new Date(p.ts || Date.now()).toLocaleTimeString();
    const dirSymbol = p.direction === "in" ? "↓" : "↑";

    const tsEl = document.createElement("span");
    tsEl.className = "ts";
    tsEl.textContent = ts;

    const dirEl = document.createElement("span");
    dirEl.className = "dir";
    dirEl.textContent = dirSymbol;

    const clsEl = document.createElement("span");
    clsEl.className = "cls";
    // Priority: protobuf Descriptor.Name (auto) > user alias (manual) > obfuscated class name
    const autoName = (p.name && p.name !== "?") ? p.name : null;
    const manualAlias = socketAliases[p.cls];
    const displayName = autoName || manualAlias || null;
    if (displayName) {
        const flag = manualAlias ? "★" : "";
        clsEl.innerHTML = `<span class="proto-name">${displayName}${flag}</span> <span class="proto-cls">(${p.cls})</span>`;
    } else {
        clsEl.textContent = p.cls || "?";
    }

    const previewEl = document.createElement("pre");
    previewEl.className = "preview";
    const lines = [];
    if (p.fullName && p.fullName !== "?") lines.push(`[${p.fullName}]`);
    if (p.fields && Object.keys(p.fields).length) {
        for (const [k, v] of Object.entries(p.fields)) lines.push(`  ${k} = ${v}`);
    } else {
        lines.push("(no field set)");
    }
    lines.push("");
    lines.push("right-click to set an alias for this class");
    previewEl.textContent = lines.join("\n");

    entry.appendChild(tsEl);
    entry.appendChild(dirEl);
    entry.appendChild(clsEl);
    entry.appendChild(previewEl);

    entry.addEventListener("click", () => entry.classList.toggle("expanded"));
    entry.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        const current = socketAliases[p.cls] || "";
        const next = prompt(`Alias for "${p.cls}":`, current);
        if (next === null) return;
        if (next === "") { delete socketAliases[p.cls]; }
        else { socketAliases[p.cls] = next; }
        saveAliases();
        // refresh: rename all existing entries with this cls
        $$(`.socket-entry[data-cls="${p.cls}"]`).forEach(el => {
            const clsEl = el.querySelector(".cls");
            if (!clsEl) return;
            const aliased = socketAliases[p.cls];
            if (aliased) clsEl.innerHTML = `<span class="proto-name">${aliased}★</span> <span class="proto-cls">(${p.cls})</span>`;
            else clsEl.textContent = p.cls;
        });
    });

    if (socketFilter && !new RegExp(socketFilter, "i").test(p.cls || "")) {
        entry.classList.add("filtered-out");
    }
    socketLogEl.appendChild(entry);
    const autoscroll = $("#socket-autoscroll");
    if (autoscroll && autoscroll.checked) socketLogEl.scrollTop = socketLogEl.scrollHeight;
}

$("#socket-clear")?.addEventListener("click", () => { if (socketLogEl) socketLogEl.innerHTML = ""; });
$("#socket-filter")?.addEventListener("input", (ev) => {
    socketFilter = ev.target.value.trim();
    $$(".socket-entry").forEach(el => {
        const match = !socketFilter || new RegExp(socketFilter, "i").test(el.dataset.cls || "");
        el.classList.toggle("filtered-out", !match);
    });
});

// ===========================================================================
// Resizable left sidebar
// ===========================================================================
(() => {
    const splitter = $("#splitter");
    if (!splitter) return;
    const MIN_W = 180;
    const MAX_W = 800;
    const DEFAULT_W = 280;

    function applyWidth(px) {
        const clamped = Math.max(MIN_W, Math.min(MAX_W, Math.round(px)));
        document.documentElement.style.setProperty("--left-width", clamped + "px");
        return clamped;
    }

    const saved = parseInt(localStorage.getItem("leftWidth") || "", 10);
    if (saved) applyWidth(saved);

    splitter.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        splitter.classList.add("active");
        document.body.classList.add("resizing");
        const mainRect = $("main").getBoundingClientRect();
        const onMove = (e) => {
            // account for main's 8px left padding
            applyWidth(e.clientX - mainRect.left - 8);
        };
        const onUp = () => {
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            splitter.classList.remove("active");
            document.body.classList.remove("resizing");
            const cur = getComputedStyle(document.documentElement).getPropertyValue("--left-width").trim();
            if (cur) localStorage.setItem("leftWidth", parseInt(cur, 10));
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    splitter.addEventListener("dblclick", () => {
        applyWidth(DEFAULT_W);
        localStorage.setItem("leftWidth", String(DEFAULT_W));
    });
})();

// ---------- init -----------------------------------------------------------
connectWS();
loadProcs();
