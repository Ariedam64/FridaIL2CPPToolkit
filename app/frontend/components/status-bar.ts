// app/frontend/components/status-bar.ts

export interface StatusBarHandle {
    setConnection(text: string, ok: boolean): void;
    setRight(text: string): void;
}

export function renderStatusBar(host: HTMLElement): StatusBarHandle {
    host.className = "statusbar";
    host.innerHTML = `
        <span class="item" id="sb-conn"><span class="dot"></span><span class="conn-text">no connection</span></span>
        <span class="right" id="sb-right">v2.0</span>
    `;
    const dot = host.querySelector<HTMLElement>(".dot")!;
    const text = host.querySelector<HTMLElement>(".conn-text")!;
    const right = host.querySelector<HTMLElement>("#sb-right")!;
    return {
        setConnection(t, ok) {
            text.textContent = t;
            dot.style.background = ok ? "var(--success)" : "var(--danger)";
            dot.style.boxShadow = `0 0 6px ${ok ? "var(--success)" : "var(--danger)"}`;
        },
        setRight(t) { right.textContent = t; },
    };
}
