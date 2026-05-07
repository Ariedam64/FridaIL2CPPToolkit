"use strict";
// Status bar item with connection + profile info. Click → refresh.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusBarController = void 0;
const vscode = __importStar(require("vscode"));
const REFRESH_INTERVAL_MS = 10_000;
class StatusBarController {
    rpc;
    profileSource;
    item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    timer;
    constructor(rpc, profileSource, refreshCommandId) {
        this.rpc = rpc;
        this.profileSource = profileSource;
        this.item.command = refreshCommandId;
        this.item.show();
        this.setDisconnected();
    }
    start() {
        if (this.timer)
            return;
        this.timer = setInterval(() => this.tick(), REFRESH_INTERVAL_MS);
        this.tick();
    }
    async tick() {
        const healthy = await this.rpc.isHealthy();
        if (!healthy) {
            this.setDisconnected();
            return;
        }
        const profile = this.profileSource.current();
        this.setConnected(profile);
    }
    setDisconnected() {
        this.item.text = `$(circle-slash) Frida: not connected`;
        this.item.tooltip = "Frida RPC unreachable. Check fridaToolkit.rpcEndpoint setting.";
        this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    setConnected(profile) {
        if (!profile) {
            this.item.text = `$(zap) Frida (no profile)`;
            this.item.tooltip = "Frida RPC reachable but profile not yet detected.";
        }
        else {
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
    dispose() {
        if (this.timer)
            clearInterval(this.timer);
        this.item.dispose();
    }
}
exports.StatusBarController = StatusBarController;
//# sourceMappingURL=status-bar.js.map