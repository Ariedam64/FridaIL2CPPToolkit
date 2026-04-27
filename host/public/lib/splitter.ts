// Drag-to-resize splitters for the app shell. Persists widths in localStorage.
const MIN_SIDEBAR = 180;
const MAX_SIDEBAR = 600;
const MIN_LIVE = 220;
const MAX_LIVE = 700;
const DEFAULT_SIDEBAR = 260;
const DEFAULT_LIVE = 320;

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

function setVar(name: string, value: string): void {
    document.documentElement.style.setProperty(name, value);
}

export function wireSplitters(): void {
    // Restore saved widths
    const savedSidebar = Number(localStorage.getItem("toolkit.sidebar-w"));
    const savedLive = Number(localStorage.getItem("toolkit.livepanel-w"));
    if (savedSidebar >= MIN_SIDEBAR && savedSidebar <= MAX_SIDEBAR) setVar("--sidebar-w", `${savedSidebar}px`);
    if (savedLive >= MIN_LIVE && savedLive <= MAX_LIVE) setVar("--livepanel-w", `${savedLive}px`);

    const splitters = document.querySelectorAll<HTMLElement>(".splitter[data-resize]");
    for (const sp of splitters) wireOne(sp);
}

function wireOne(splitter: HTMLElement): void {
    const side = splitter.dataset.resize; // "left" or "right"
    if (side !== "left" && side !== "right") return;

    splitter.addEventListener("mousedown", (e) => {
        e.preventDefault();
        splitter.classList.add("dragging");
        const startX = e.clientX;
        const sidebar = document.getElementById("sidebar")!;
        const sideLive = document.getElementById("side-live")!;
        const startSidebar = sidebar.getBoundingClientRect().width;
        const startLive = sideLive.getBoundingClientRect().width;

        function onMove(ev: MouseEvent): void {
            const dx = ev.clientX - startX;
            if (side === "left") {
                const w = clamp(startSidebar + dx, MIN_SIDEBAR, MAX_SIDEBAR);
                setVar("--sidebar-w", `${w}px`);
            } else {
                const w = clamp(startLive - dx, MIN_LIVE, MAX_LIVE);
                setVar("--livepanel-w", `${w}px`);
            }
        }

        function onUp(): void {
            splitter.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
            // Persist
            const sbW = Math.round(document.getElementById("sidebar")!.getBoundingClientRect().width);
            const lvW = Math.round(document.getElementById("side-live")!.getBoundingClientRect().width);
            localStorage.setItem("toolkit.sidebar-w", String(sbW));
            localStorage.setItem("toolkit.livepanel-w", String(lvW));
        }

        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
    });

    splitter.addEventListener("dblclick", () => {
        if (side === "left") {
            setVar("--sidebar-w", `${DEFAULT_SIDEBAR}px`);
            localStorage.removeItem("toolkit.sidebar-w");
        } else {
            setVar("--livepanel-w", `${DEFAULT_LIVE}px`);
            localStorage.removeItem("toolkit.livepanel-w");
        }
    });
}
