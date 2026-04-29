// Status bar item with connection + profile info. Click → refresh.

import * as vscode from "vscode";

import type { Profile } from "./profile";
import type { RpcClient } from "./types";

const REFRESH_INTERVAL_MS = 10_000;

export class StatusBarController {
    private item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    private timer?: NodeJS.Timeout;

    constructor(
        private readonly rpc: RpcClient,
        private readonly profileSource: { current(): Profile | null },
        refreshCommandId: string,
    ) {
        this.item.command = refreshCommandId;
        this.item.show();
        this.setDisconnected();
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.tick(), REFRESH_INTERVAL_MS);
        this.tick();
    }

    async tick(): Promise<void> {
        const healthy = await this.rpc.isHealthy();
        if (!healthy) {
            this.setDisconnected();
            return;
        }
        const profile = this.profileSource.current();
        this.setConnected(profile);
    }

    setDisconnected(): void {
        this.item.text = `$(circle-slash) Frida: not connected`;
        this.item.tooltip = "Frida RPC unreachable. Check fridaToolkit.rpcEndpoint setting.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }

    setConnected(profile: Profile | null): void {
        if (!profile) {
            this.item.text = `$(zap) Frida (no profile)`;
            this.item.tooltip = "Frida RPC reachable but profile not yet detected.";
        } else {
            const buildShort = profile.manifest.buildId.slice(0, 8);
            this.item.text = `$(zap) ${profile.manifest.gameName} | ${buildShort}`;
            this.item.tooltip =
                `Game: ${profile.manifest.gameName}\n` +
                `Build: ${profile.manifest.buildId}\n` +
                `Source: ${profile.manifest.buildIdSource}\n` +
                `Labels: ${profile.manifest.stats.totalLabels}, ` +
                `Bookmarks: ${profile.manifest.stats.totalBookmarks}, ` +
                `Notes: ${profile.manifest.stats.totalNotes}`;
        }
        this.item.backgroundColor = undefined;
    }

    dispose(): void {
        if (this.timer) clearInterval(this.timer);
        this.item.dispose();
    }
}
