// HTTP RPC client for the Frida agent. Backend lives at the URL defined in
// the fridaToolkit.rpcEndpoint setting (default localhost:3001/api/call).
//
// Two methods:
//   - call<T>(method, args)  : invoke an RPC; throws on error
//   - isHealthy()            : ping; returns true if the agent answered
//
// Caller code is responsible for catching errors. This module deliberately
// avoids depending on vscode.* so it can be unit-tested in plain Node.

import * as http from "http";
import { URL } from "url";

import type { RpcClient } from "./types";

interface RpcResponse<T> {
    result?: T;
    error?: string;
}

export interface RpcClientOptions {
    endpoint: string;          // e.g. "http://localhost:3001/api/call"
    timeoutMs?: number;        // default 30_000
}

export class HttpRpcClient implements RpcClient {
    private readonly url: URL;
    private readonly timeoutMs: number;

    constructor(opts: RpcClientOptions) {
        this.url = new URL(opts.endpoint);
        this.timeoutMs = opts.timeoutMs ?? 30_000;
    }

    call<T>(method: string, args: unknown[] = []): Promise<T> {
        const body = JSON.stringify({ method, args });
        return new Promise<T>((resolve, reject) => {
            const req = http.request(
                {
                    hostname: this.url.hostname,
                    port: parseInt(this.url.port || "80", 10),
                    path: this.url.pathname,
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(body),
                    },
                    timeout: this.timeoutMs,
                },
                (res) => {
                    let chunks = "";
                    res.on("data", (c) => (chunks += c));
                    res.on("end", () => {
                        try {
                            const parsed = JSON.parse(chunks) as RpcResponse<T>;
                            if (parsed.error !== undefined) {
                                reject(new Error(parsed.error));
                            } else {
                                resolve(parsed.result as T);
                            }
                        } catch (e) {
                            reject(e instanceof Error ? e : new Error(String(e)));
                        }
                    });
                }
            );
            req.on("error", reject);
            req.on("timeout", () => req.destroy(new Error("RPC timeout")));
            req.write(body);
            req.end();
        });
    }

    async isHealthy(): Promise<boolean> {
        try {
            // listAssembliesInfo is a cheap RPC that exists in the agent.
            // Use it as the health probe.
            await this.call<unknown[]>("listAssembliesInfo", []);
            return true;
        } catch {
            return false;
        }
    }
}
