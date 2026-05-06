// app/frontend/main.ts
import { connectWs, subscribe } from "./core/ws.js";
import { api } from "./core/api.js";
import { renderNavIcons, type NavTab } from "./components/nav-icons.js";
import { renderStatusBar } from "./components/status-bar.js";
import { mountExplorerPage } from "./pages/explorer.js";

const root = document.getElementById("app")!;
root.innerHTML = `
    <div class="titlebar">
        <span class="title">Frida IL2CPP Toolkit</span>
        <span class="kbd">⌘K</span>
        <span class="badge disconnected" id="conn-badge">disconnected</span>
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
    if (tab === "explorer") {
        mountExplorerPage(pageHost);
    } else {
        pageHost.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">${tab} (coming next task)</div>`;
    }
}

const navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
        mountPage(tab);
    },
});

window.addEventListener("hashchange", () => {
    const tab = (location.hash.replace(/^#\//, "") || "explorer") as NavTab;
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

const initialTab = (location.hash.replace(/^#\//, "") || "explorer") as NavTab;
navHandle.setActive(initialTab);
mountPage(initialTab);
