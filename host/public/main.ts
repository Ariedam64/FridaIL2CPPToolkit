// Entry point — boots WS, mounts all panels, wires tab switching.
import { connect as wsConnect, onWsEvent } from "./lib/ws.js";
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
import { clearSession } from "./lib/session.js";
import { renderBookmarks, initBookmarkAutoOffer } from "./panels/bookmarks.js";
import { renderScanner } from "./panels/scanner.js";
import { renderInspector } from "./panels/inspector.js";
import { renderDiff } from "./panels/diff.js";
import { renderMap } from "./panels/map.js";
import { renderWorldMap } from "./panels/worldmap.js";

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

// ── Session tracker: clear on detach
onWsEvent((ev) => { if (ev.type === "detached") clearSession(); });

// ── Disconnected state banner
const banner = document.getElementById("disconnected-banner") as HTMLElement;
onWsEvent((ev) => {
    if (ev.type === "detached") {
        banner.querySelector(".text")!.textContent = `DETACHED${(ev as any).reason ? ` · ${(ev as any).reason}` : ""} — pick a process to reattach`;
        banner.style.display = "";
    } else if (ev.type === "attached" || ev.type === "hello") {
        if (ev.type === "hello" && !(ev as any).attached) return;
        banner.style.display = "none";
    }
});

// ── Auto-offer matching bookmark toast (module-level subscription, once)
initBookmarkAutoOffer();

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
    else if (name === "bookmarks") renderBookmarks(wrap);
}

// ── Main panel tab rendering
const mainContent = $("#main-content");

function renderMainTab(name: string): void {
    const wrap = freshWrapper(mainContent);
    if (name === "search")         renderSearch(wrap);
    else if (name === "instance")  renderInstance(wrap);
    else if (name === "scanner")   renderScanner(wrap);
    else if (name === "inspector") renderInspector(wrap);
    else if (name === "hookpatch") renderHookPatch(wrap);
    else if (name === "diff")      renderDiff(wrap);
    else if (name === "socket")    renderSocket(wrap);
    else if (name === "map")       renderMap(wrap);
    else if (name === "worldmap")  renderWorldMap(wrap);
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

// ── Keybinds
document.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    // Ctrl+K — clear log
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.getElementById("log")!.innerHTML = "";
        return;
    }
    // Ctrl+Shift+C — copy session (trigger existing button)
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        const btn = [...document.querySelectorAll("button")].find(b => b.textContent?.includes("Copy session")) as HTMLButtonElement | undefined;
        btn?.click();
        return;
    }
    // Escape — dismiss toast (bookmark auto-offer)
    if (e.key === "Escape") {
        const toast = document.querySelector(".bookmark-toast");
        if (toast) toast.remove();
    }
});

console.log("[main] bootstrapped");
