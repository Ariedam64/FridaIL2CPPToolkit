"use strict";
// HTTP RPC client for the Frida agent. Backend lives at the URL defined in
// the fridaToolkit.rpcEndpoint setting (default localhost:3001/api/call).
//
// Two methods:
//   - call<T>(method, args)  : invoke an RPC; throws on error
//   - isHealthy()            : ping; returns true if the agent answered
//
// Caller code is responsible for catching errors. This module deliberately
// avoids depending on vscode.* so it can be unit-tested in plain Node.
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
exports.HttpRpcClient = void 0;
const http = __importStar(require("http"));
const url_1 = require("url");
class HttpRpcClient {
    url;
    timeoutMs;
    constructor(opts) {
        this.url = new url_1.URL(opts.endpoint);
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }
    call(method, args = []) {
        const body = JSON.stringify({ method, args });
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.url.hostname,
                port: parseInt(this.url.port || "80", 10),
                path: this.url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: this.timeoutMs,
            }, (res) => {
                let chunks = "";
                res.on("data", (c) => (chunks += c));
                res.on("end", () => {
                    try {
                        const parsed = JSON.parse(chunks);
                        if (parsed.error !== undefined) {
                            reject(new Error(parsed.error));
                        }
                        else {
                            resolve(parsed.result);
                        }
                    }
                    catch (e) {
                        reject(e instanceof Error ? e : new Error(String(e)));
                    }
                });
            });
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("RPC timeout")));
            req.write(body);
            req.end();
        });
    }
    async isHealthy() {
        try {
            // listAssembliesInfo is a cheap RPC that exists in the agent.
            // Use it as the health probe.
            await this.call("listAssembliesInfo", []);
            return true;
        }
        catch {
            return false;
        }
    }
}
exports.HttpRpcClient = HttpRpcClient;
//# sourceMappingURL=rpc.js.map