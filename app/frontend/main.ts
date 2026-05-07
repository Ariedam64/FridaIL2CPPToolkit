// app/frontend/main.ts
import { connectWs, subscribe } from "./core/ws.js";
import { api } from "./core/api.js";
import { renderNavIcons, type NavTab } from "./components/nav-icons.js";
import { renderStatusBar } from "./components/status-bar.js";
import { mountExplorerPage } from "./pages/explorer.js";
import { mountBookmarksPage } from "./pages/bookmarks.js";
import { mountMigrationsPage } from "./pages/migrations.js";
import { mountHooksPage } from "./pages/hooks.js";
import { mountNetworkPage } from "./pages/network.js";
import { mountInstancesPage } from "./pages/instances.js";
import { showProcessPicker } from "./components/process-picker.js";
import { bindPaletteShortcut } from "./components/command-palette.js";

const root = document.getElementById("app")!;
root.innerHTML = `
    <div class="titlebar">
        <span class="title">Frida IL2CPP Toolkit</span>
        <span class="kbd">⌘K</span>
        <button class="pill" id="attach-btn" style="margin-left:auto">Attach…</button>
        <span class="badge disconnected" id="conn-badge" style="margin-left:8px">disconnected</span>
    </div>
    <div class="main-row" id="main-row">
        <div id="nav-icons-host"></div>
        <div id="page-host"></div>
    </div>
    <div id="statusbar-host"></div>
`;

const sb = renderStatusBar(document.getElementById("statusbar-host")!);
const connBadge = document.getElementById("conn-badge")!;
const pageHost = document.getElementById("page-host")!;
pageHost.style.flex = "1";
pageHost.style.display = "flex";
pageHost.style.minHeight = "0";

function mountPage(tab: NavTab): void {
    pageHost.innerHTML = "";
    if (tab === "explorer") mountExplorerPage(pageHost);
    else if (tab === "hooks") mountHooksPage(pageHost);
    else if (tab === "network") mountNetworkPage(pageHost);
    else if (tab === "bookmarks") mountBookmarksPage(pageHost);
    else if (tab === "migrations") mountMigrationsPage(pageHost);
    else if (tab === "instances") mountInstancesPage(pageHost);
}

const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
        mountPage(tab);
    },
});

window.addEventListener("hashchange", () => {
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    navHandle.setActive(tab);
    mountPage(tab);
});

async function refreshProfile(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (profile) {
            sb.setConnection(`${profile.manifest.gameName} / ${profile.manifest.buildId.slice(0, 8)}`, true);
            connBadge.textContent = "connected";
            connBadge.classList.remove("disconnected");
        } else {
            sb.setConnection("no connection", false);
            connBadge.textContent = "disconnected";
            connBadge.classList.add("disconnected");
        }
    } catch (e) { console.warn("getProfile failed:", e); }
}

connectWs();
subscribe("profile-attached", refreshProfile);
subscribe("profile-detached", refreshProfile);
void refreshProfile();

const initialTab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
navHandle.setActive(initialTab);
mountPage(initialTab);

document.getElementById("attach-btn")!.addEventListener("click", () => {
    void showProcessPicker();
});

// Show the picker if no profile attached at boot.
async function ensureAttached(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (!profile) await showProcessPicker();
    } catch { /* no backend yet, skip */ }
}
void ensureAttached();

bindPaletteShortcut();
