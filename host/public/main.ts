// Entry point — boots WS, mounts all panels, wires tab switching.
import { connect as wsConnect } from "./lib/ws.js";
import { detach, reload } from "./lib/rpc.js";
import { wireSplitters } from "./lib/splitter.js";
import { mountConnection, wireStatusAndButtons } from "./panels/connection.js";
import { mountLogs } from "./panels/logs.js";
import { renderSearch } from "./panels/search.js";
import { renderInstance } from "./panels/instance.js";
import { renderHookPatch } from "./panels/hookpatch.js";
import { renderSocket } from "./panels/socket.js";
import { renderExplorer } from "./panels/explorer.js";
import { mountWatchlist } from "./panels/watchlist.js";

function $(sel: string, root: ParentNode = document): HTMLElement {
    const el = root.querySelector(sel);
    if (!el) throw new Error(`element not found: ${sel}`);
    return el as HTMLElement;
}

function wireTabs(groupName: string, contentEl: HTMLElement): void {
    const tabsEl = document.querySelector(`[data-tabs="${groupName}"]`) as HTMLElement | null;
    if (!tabsEl) return;
    tabsEl.addEventListener("click", (e) => {
        const btn = (e.target as HTMLElement).closest(".tab") as HTMLElement | null;
        if (!btn || !btn.dataset["tab"]) return;
        for (const t of tabsEl.querySelectorAll(".tab")) t.classList.remove("active");
        btn.classList.add("active");
        contentEl.dataset["active"] = btn.dataset["tab"];
        document.dispatchEvent(new CustomEvent("tab-change", { detail: { group: groupName, name: btn.dataset["tab"] } }));
    });
}

wireTabs("sidebar", $("#sidebar-content"));
wireTabs("main", $("#main-content"));
wireSplitters();

// Connect WebSocket (must happen before any panel that calls onWsEvent)
wsConnect();

// ── One-time setup: status pill + detach/reload buttons (not in mountConnection so they don't double-register)
const statusEl   = $("#status");
const btnDetach  = $("#btn-detach")  as HTMLButtonElement;
const btnReload  = $("#btn-reload")  as HTMLButtonElement;

wireStatusAndButtons(statusEl, btnDetach, btnReload);

btnDetach.addEventListener("click", () => { void detach(); });
btnReload.addEventListener("click", () => { void reload(); });

// ── Logs panel (right column, always mounted)
mountLogs($("#log"));

// ── Watchlist panel (right column, always mounted)
mountWatchlist($("#watchlist"));

// Each tab switch creates a fresh wrapper div. When we remove the wrapper,
// all DOM listeners attached to it (by the panel's render function) die with it.
// This prevents the "click fires the RPC twice" class of bugs after tab cycling.
function freshWrapper(container: HTMLElement): HTMLElement {
    container.replaceChildren();
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-direction:column; min-height:0; height:100%; overflow:auto";
    container.appendChild(wrap);
    return wrap;
}

// ── Sidebar tab rendering
const sidebarContent = $("#sidebar-content");

function renderSidebarTab(name: string): void {
    const wrap = freshWrapper(sidebarContent);
    if (name === "processes")      mountConnection(wrap);
    else if (name === "explorer")  renderExplorer(wrap);
}

// ── Main panel tab rendering
const mainContent = $("#main-content");

function renderMainTab(name: string): void {
    const wrap = freshWrapper(mainContent);
    if (name === "search")         renderSearch(wrap);
    else if (name === "instance")  renderInstance(wrap);
    else if (name === "hookpatch") renderHookPatch(wrap);
    else if (name === "socket")    renderSocket(wrap);
}

// ── Listen for tab-change events (fired by wireTabs above)
document.addEventListener("tab-change", (e) => {
    const detail = (e as CustomEvent).detail as { group: string; name: string };
    if (detail.group === "sidebar") renderSidebarTab(detail.name);
    else if (detail.group === "main") renderMainTab(detail.name);
});

// ── Initial render of default tabs
renderSidebarTab("processes");
renderMainTab("search");

console.log("[main] bootstrapped");
