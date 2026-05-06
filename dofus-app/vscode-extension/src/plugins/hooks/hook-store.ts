import * as crypto from "crypto";

import type { PluginStorage } from "../../core/api";
import type { HookSpec, StoredHook } from "./types";

interface RpcLike {
    call<T>(method: string, args?: unknown[]): Promise<T>;
}

interface DiskShape {
    hooks: Array<Omit<StoredHook, "installedHookId">>;
}

const STORAGE_KEY = "hooks";

type Listener = () => void;

export class HookStore {
    private hooks: StoredHook[] = [];
    private listeners: Listener[] = [];

    constructor(
        private readonly storage: PluginStorage,
        private readonly rpc: RpcLike,
    ) {
        this.reload();
    }

    /** Refresh from disk. All hooks come back disarmed. */
    reload(): void {
        const raw = this.storage.get<DiskShape>(STORAGE_KEY);
        const arr = raw?.hooks ?? [];
        this.hooks = arr.map((h) => ({
            id: h.id,
            spec: h.spec,
            installedHookId: null,
            addedAt: h.addedAt,
        }));
        this.emit();
    }

    list(): StoredHook[] {
        return this.hooks.map((h) => ({ ...h }));
    }

    add(spec: HookSpec): StoredHook {
        const stored: StoredHook = {
            id: crypto.randomUUID(),
            spec,
            installedHookId: null,
            addedAt: Date.now(),
        };
        this.hooks.push(stored);
        this.persist();
        this.emit();
        return { ...stored };
    }

    async update(id: string, spec: HookSpec): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) throw new Error(`hook ${id} not found`);
        const wasInstalled = h.installedHookId !== null;
        if (wasInstalled) {
            await this.rpc.call("revertHook", [h.installedHookId]);
            h.installedHookId = null;
        }
        h.spec = spec;
        if (wasInstalled) {
            const r = await this.rpc.call<{ hookId: string }>("installHook", [spec]);
            h.installedHookId = r.hookId;
        }
        this.persist();
        this.emit();
    }

    async remove(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) return;
        if (h.installedHookId !== null) {
            await this.rpc.call("revertHook", [h.installedHookId]);
        }
        this.hooks = this.hooks.filter((x) => x.id !== id);
        this.persist();
        this.emit();
    }

    async install(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) throw new Error(`hook ${id} not found`);
        if (h.installedHookId !== null) return;
        const r = await this.rpc.call<{ hookId: string }>("installHook", [h.spec]);
        h.installedHookId = r.hookId;
        this.emit();
    }

    async uninstall(id: string): Promise<void> {
        const h = this.hooks.find((x) => x.id === id);
        if (!h) return;
        if (h.installedHookId === null) return;
        await this.rpc.call("revertHook", [h.installedHookId]);
        h.installedHookId = null;
        this.emit();
    }

    async uninstallAll(): Promise<void> {
        for (const h of this.hooks) {
            if (h.installedHookId !== null) {
                try { await this.rpc.call("revertHook", [h.installedHookId]); }
                catch { /* keep going */ }
                h.installedHookId = null;
            }
        }
        this.emit();
    }

    /** Reset every installedHookId without an RPC call — for use on detach. */
    markAllDisarmed(): void {
        for (const h of this.hooks) h.installedHookId = null;
        this.emit();
    }

    /** Mark a hook as disarmed because the agent auto-reverted it. */
    markDisarmedByHookId(installedHookId: string): boolean {
        const h = this.hooks.find((x) => x.installedHookId === installedHookId);
        if (!h) return false;
        h.installedHookId = null;
        this.emit();
        return true;
    }

    onChange(listener: Listener): () => void {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0) this.listeners.splice(i, 1);
        };
    }

    private emit(): void {
        for (const l of this.listeners) {
            try { l(); } catch { /* swallow */ }
        }
    }

    private persist(): void {
        const data: DiskShape = {
            hooks: this.hooks.map((h) => ({
                id: h.id, spec: h.spec, addedAt: h.addedAt,
            })),
        };
        this.storage.set(STORAGE_KEY, data);
    }
}
