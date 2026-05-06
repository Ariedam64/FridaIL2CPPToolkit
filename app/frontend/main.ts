// app/frontend/main.ts — bootstrap

const root = document.getElementById("app")!;

function renderShell(): void {
    root.innerHTML = `
        <div class="titlebar">
            <span class="title">Frida IL2CPP Toolkit</span>
            <span class="kbd">⌘K</span>
            <span class="badge disconnected" id="conn-badge">disconnected</span>
        </div>
        <div class="main-row" id="main-row">
            <div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-faint)">
                Loading…
            </div>
        </div>
        <div class="statusbar">
            <span class="item" id="status-conn">no connection</span>
            <span class="right">v2.0</span>
        </div>
    `;
}

renderShell();
console.log("[frida-toolkit] frontend loaded");
