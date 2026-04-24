// Entry point — Dofus app shell. Boots WS, mounts world + travel panels,
// wires the process picker on the sidebar.
import { connect as wsConnect, onWsEvent } from "./lib/ws.js";
import { detach, reload } from "./lib/rpc.js";
import { wireSplitters } from "./lib/splitter.js";
import { mountConnection, wireStatusAndButtons } from "./panels/connection.js";
import { mountLogs } from "./panels/logs.js";
import { renderWorld } from "./panels/world.js";
import { renderMap } from "./panels/map.js";

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

wsConnect();

const statusEl  = $("#status");
const btnDetach = $("#btn-detach") as HTMLButtonElement;
const btnReload = $("#btn-reload") as HTMLButtonElement;
wireStatusAndButtons(statusEl, btnDetach, btnReload);
btnDetach.addEventListener("click", () => { void detach(); });
btnReload.addEventListener("click", () => { void reload(); });

mountLogs($("#log"));

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

function freshWrapper(container: HTMLElement): HTMLElement {
    container.replaceChildren();
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex; flex-direction:column; min-height:0; height:100%; overflow:auto";
    container.appendChild(wrap);
    return wrap;
}

const sidebarContent = $("#sidebar-content");
function renderSidebarTab(name: string): void {
    const wrap = freshWrapper(sidebarContent);
    if (name === "processes") mountConnection(wrap);
}

const mainContent = $("#main-content");
function renderMainTab(name: string): void {
    const wrap = freshWrapper(mainContent);
    if (name === "world")    void renderWorld(wrap);
    else if (name === "map") renderMap(wrap);
}

document.addEventListener("tab-change", (e) => {
    const detail = (e as CustomEvent).detail as { group: string; name: string };
    if (detail.group === "sidebar") renderSidebarTab(detail.name);
    else if (detail.group === "main") renderMainTab(detail.name);
});

renderSidebarTab("processes");
renderMainTab("world");

console.log("[dofus-app] bootstrapped");
