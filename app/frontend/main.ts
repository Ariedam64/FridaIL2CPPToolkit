// app/frontend/main.ts
import { connectWs, subscribe } from "./core/ws.js";
import { api } from "./core/api.js";
import { renderNavIcons, type NavTab } from "./components/nav-icons.js";
import { renderStatusBar } from "./components/status-bar.js";

const root = document.getElementById("app")!;
root.innerHTML = `
    <div class="titlebar">
        <span class="title">Frida IL2CPP Toolkit</span>
        <span class="kbd">⌘K</span>
        <span class="badge disconnected" id="conn-badge">disconnected</span>
    </div>
    <div class="main-row" id="main-row">
        <div id="nav-icons-host"></div>
        <div id="page-host" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">
            Loading…
        </div>
    </div>
    <div id="statusbar-host"></div>
`;

const _navHandle = renderNavIcons(document.getElementById("nav-icons-host")!, {
    onSelect: (tab: NavTab) => {
        location.hash = `#/${tab}`;
    },
});
const sb = renderStatusBar(document.getElementById("statusbar-host")!);
const connBadge = document.getElementById("conn-badge")!;

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
    } catch (e) {
        console.warn("getProfile failed:", e);
    }
}

connectWs();
subscribe("profile-attached", refreshProfile);
subscribe("profile-detached", refreshProfile);
void refreshProfile();
