"use strict";
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
exports.HookStore = void 0;
const crypto = __importStar(require("crypto"));
const STORAGE_KEY = "hooks";
class HookStore {
    storage;
    rpc;
    hooks = [];
    listeners = [];
    constructor(storage, rpc) {
        this.storage = storage;
        this.rpc = rpc;
        this.reload();
    }
    /** Refresh from disk. All hooks come back disarmed. */
    reload() {
        const raw = this.storage.get(STORAGE_KEY);
        const arr = raw?.hooks ?? [];
        this.hooks = arr.map((h) => ({
            id: h.id,
            spec: h.spec,
            installedHookId: null,
            addedAt: h.addedAt,
        }));
        this.emit();
    }
    list() {
        return this.hooks.map((h) => ({ ...h }));
    }
    add(spec) {
        const stored = {
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
    async update(id, spec) {
        const h = this.hooks.find((x) => x.id === id);
        if (!h)
            throw new Error(`hook ${id} not found`);
        const wasInstalled = h.installedHookId !== null;
        if (wasInstalled) {
            await this.rpc.call("revertHook", [h.installedHookId]);
            h.installedHookId = null;
        }
        h.spec = spec;
        if (wasInstalled) {
            const r = await this.rpc.call("installHook", [spec]);
            h.installedHookId = r.hookId;
        }
        this.persist();
        this.emit();
    }
    async remove(id) {
        const h = this.hooks.find((x) => x.id === id);
        if (!h)
            return;
        if (h.installedHookId !== null) {
            await this.rpc.call("revertHook", [h.installedHookId]);
        }
        this.hooks = this.hooks.filter((x) => x.id !== id);
        this.persist();
        this.emit();
    }
    async install(id) {
        const h = this.hooks.find((x) => x.id === id);
        if (!h)
            throw new Error(`hook ${id} not found`);
        if (h.installedHookId !== null)
            return;
        const r = await this.rpc.call("installHook", [h.spec]);
        h.installedHookId = r.hookId;
        this.emit();
    }
    async uninstall(id) {
        const h = this.hooks.find((x) => x.id === id);
        if (!h)
            return;
        if (h.installedHookId === null)
            return;
        await this.rpc.call("revertHook", [h.installedHookId]);
        h.installedHookId = null;
        this.emit();
    }
    async uninstallAll() {
        for (const h of this.hooks) {
            if (h.installedHookId !== null) {
                try {
                    await this.rpc.call("revertHook", [h.installedHookId]);
                }
                catch { /* keep going */ }
                h.installedHookId = null;
            }
        }
        this.emit();
    }
    /** Reset every installedHookId without an RPC call — for use on detach. */
    markAllDisarmed() {
        for (const h of this.hooks)
            h.installedHookId = null;
        this.emit();
    }
    /** Mark a hook as disarmed because the agent auto-reverted it. */
    markDisarmedByHookId(installedHookId) {
        const h = this.hooks.find((x) => x.installedHookId === installedHookId);
        if (!h)
            return false;
        h.installedHookId = null;
        this.emit();
        return true;
    }
    onChange(listener) {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0)
                this.listeners.splice(i, 1);
        };
    }
    emit() {
        for (const l of this.listeners) {
            try {
                l();
            }
            catch { /* swallow */ }
        }
    }
    persist() {
        const data = {
            hooks: this.hooks.map((h) => ({
                id: h.id, spec: h.spec, addedAt: h.addedAt,
            })),
        };
        this.storage.set(STORAGE_KEY, data);
    }
}
exports.HookStore = HookStore;
//# sourceMappingURL=hook-store.js.map