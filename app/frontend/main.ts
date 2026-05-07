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
import { mountScriptsPage } from "./pages/scripts.js";
import { showProcessPicker } from "./components/process-picker.js";
import { getPlugin } from "./core/plugin-host.js";
import { mountPluginPage } from "./core/mount-plugin-page.js";
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
let cachedProfile: { gameName: string; buildId: string } | null = null;
const connBadge = document.getElementById("conn-badge")!;
const pageHost = document.getElementById("page-host")!;
pageHost.style.flex = "1";
pageHost.style.display = "flex";
pageHost.style.minHeight = "0";

async function mountPage(tab: NavTab): Promise<void> {
    pageHost.innerHTML = "";
    pageHost.style.cssText = "";
    pageHost.style.flex = "1";
    pageHost.style.display = "flex";
    pageHost.style.minHeight = "0";

    if (tab === "explorer") return mountExplorerPage(pageHost);
    if (tab === "hooks") return mountHooksPage(pageHost);
    if (tab === "network") return mountNetworkPage(pageHost);
    if (tab === "bookmarks") return mountBookmarksPage(pageHost);
    if (tab === "migrations") return mountMigrationsPage(pageHost);
    if (tab === "instances") return mountInstancesPage(pageHost);
    if (tab === "scripts") return mountScriptsPage(pageHost);

    // Plugin fallback
    const plugin = getPlugin(tab);
    if (plugin) {
        await mountPluginPage(pageHost, plugin, {
            profile: cachedProfile,
            currentSubTab: parseSubTab(location.hash),
            setSubTab: (key) => { location.hash = `#/${plugin.id}?sub=${encodeURIComponent(key)}`; },
            onAttachClick: () => void showProcessPicker(),
        });
        return;
    }

    // Unknown tab → default to explorer
    return mountExplorerPage(pageHost);
}

function parseSubTab(hash: string): string | null {
    const m = /\?sub=([^&]+)/.exec(hash);
    return m ? decodeURIComponent(m[1]) : null;
}

const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
        void mountPage(tab);
    },
});

window.addEventListener("hashchange", () => {
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    navHandle.setActive(tab);
    void mountPage(tab);
});

async function refreshProfile(): Promise<void> {
    try {
        const { profile } = await api.getProfile();
        if (profile) {
            cachedProfile = { gameName: profile.manifest.gameName, buildId: profile.manifest.buildId };
            sb.setConnection(`${profile.manifest.gameName} / ${profile.manifest.buildId.slice(0, 8)}`, true);
            connBadge.textContent = "connected";
            connBadge.classList.remove("disconnected");
        } else {
            cachedProfile = null;
            sb.setConnection("no connection", false);
            connBadge.textContent = "disconnected";
            connBadge.classList.add("disconnected");
        }
        navHandle.setPluginMatchState(cachedProfile?.gameName ?? null);
    } catch (e) { console.warn("getProfile failed:", e); }
}

connectWs();
subscribe("profile-attached", () => { void refreshProfile().then(maybeRemountPlugin); });
subscribe("profile-detached", () => { void refreshProfile().then(maybeRemountPlugin); });
void refreshProfile();

function maybeRemountPlugin(): void {
    const tab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
    if (getPlugin(tab)) void mountPage(tab);
}

// Forward script WS events to the active page host as CustomEvents.
// WS messages arrive as { type, payload } envelopes — unwrap to pass only the
// payload as the CustomEvent detail so page handlers receive the actual data object.
for (const type of ["script-list-changed", "script-log", "script-result"] as const) {
    subscribe(type, (msg) => {
        pageHost.dispatchEvent(new CustomEvent(type, { detail: msg.payload ?? msg }));
    });
}

const initialTab = (location.hash.replace(/^#\//, "").split("?")[0] || "explorer") as NavTab;
navHandle.setActive(initialTab);
void mountPage(initialTab);

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
