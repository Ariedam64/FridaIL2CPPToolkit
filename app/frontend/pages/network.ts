import { mountNetworkMonitor } from "../components/network-monitor.js";

export function mountNetworkPage(host: HTMLElement): void {
    const dispose = mountNetworkMonitor(host);
    // Page is replaced when nav switches; the main.ts handler sets innerHTML="" first, so listeners auto-clean.
    // Still, capture the dispose handle on the host for future cleanup hooks if any.
    (host as unknown as { __netDispose?: () => void }).__netDispose = dispose;
}
