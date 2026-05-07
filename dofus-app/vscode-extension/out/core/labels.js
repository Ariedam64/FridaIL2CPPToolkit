"use strict";
// Label store: persistent CRUD over class/method/field renames.
// File-backed JSON, atomic writes, in-memory undo/redo ring (50 entries).
// Decoupled from vscode.* — uses a minimal Listener pattern.
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
exports.LabelStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const UNDO_BUFFER_SIZE = 50;
class LabelStore {
    classes = new Map();
    methods = new Map();
    fields = new Map();
    listeners = [];
    filePath;
    dirty = false;
    flushPromise = Promise.resolve();
    scheduledTimer = null;
    undoStack = [];
    redoStack = [];
    onCorruption;
    constructor(filePath, onCorruption) {
        this.filePath = filePath;
        this.onCorruption = onCorruption;
        this.loadFromDisk();
    }
    get(key) {
        const entry = this.lookup(key);
        return entry ? entry.label : null;
    }
    display(key) {
        const label = this.get(key);
        if (label)
            return label;
        switch (key.kind) {
            case "class": return key.className;
            case "method": return key.methodName;
            case "field": return key.fieldName;
        }
    }
    /** Total number of labels across all kinds. Cheap. */
    totalCount() {
        return this.classes.size + this.methods.size + this.fields.size;
    }
    isObfuscated(key) {
        const name = key.kind === "class" ? key.className
            : key.kind === "method" ? key.methodName
                : key.fieldName;
        return /^[a-z]{1,4}$/.test(name);
    }
    set(key, friendly) {
        const old = this.get(key);
        if (old === friendly)
            return;
        const apply = () => {
            const now = new Date().toISOString();
            const existing = this.lookup(key);
            const entry = {
                label: friendly,
                createdAt: existing ? existing.createdAt : now,
                updatedAt: now,
            };
            this.put(key, entry);
            this.markDirty();
            this.emit({ key, oldLabel: existing ? existing.label : null, newLabel: friendly });
        };
        const revert = () => {
            if (old === null) {
                this.delete(key);
            }
            else {
                const now = new Date().toISOString();
                this.put(key, { label: old, createdAt: now, updatedAt: now });
            }
            this.markDirty();
            this.emit({ key, oldLabel: friendly, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }
    remove(key) {
        const old = this.get(key);
        if (old === null)
            return;
        const apply = () => {
            this.delete(key);
            this.markDirty();
            this.emit({ key, oldLabel: old, newLabel: null });
        };
        const revert = () => {
            const now = new Date().toISOString();
            this.put(key, { label: old, createdAt: now, updatedAt: now });
            this.markDirty();
            this.emit({ key, oldLabel: null, newLabel: old });
        };
        this.pushUndo({ apply, revert });
        apply();
    }
    undo() {
        const frame = this.undoStack.pop();
        if (!frame)
            return false;
        frame.revert();
        this.redoStack.push(frame);
        return true;
    }
    redo() {
        const frame = this.redoStack.pop();
        if (!frame)
            return false;
        frame.apply();
        this.undoStack.push(frame);
        return true;
    }
    pushUndo(frame) {
        this.undoStack.push(frame);
        if (this.undoStack.length > UNDO_BUFFER_SIZE)
            this.undoStack.shift();
        this.redoStack.length = 0;
    }
    bulkImport(json) {
        const data = json;
        if (!data || data.schemaVersion !== 1)
            return { imported: 0, skipped: 0 };
        let imported = 0;
        let skipped = 0;
        for (const [k, v] of Object.entries(data.classes ?? {})) {
            if (this.classes.has(k)) {
                skipped++;
                continue;
            }
            this.classes.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.methods ?? {})) {
            if (this.methods.has(k)) {
                skipped++;
                continue;
            }
            this.methods.set(k, v);
            imported++;
        }
        for (const [k, v] of Object.entries(data.fields ?? {})) {
            if (this.fields.has(k)) {
                skipped++;
                continue;
            }
            this.fields.set(k, v);
            imported++;
        }
        if (imported > 0)
            this.markDirty();
        return { imported, skipped };
    }
    bulkExport() {
        return {
            schemaVersion: 1,
            classes: Object.fromEntries(this.classes),
            methods: Object.fromEntries(this.methods),
            fields: Object.fromEntries(this.fields),
        };
    }
    onChange(listener) {
        this.listeners.push(listener);
        return () => {
            const i = this.listeners.indexOf(listener);
            if (i >= 0)
                this.listeners.splice(i, 1);
        };
    }
    emit(event) {
        for (const l of this.listeners) {
            try {
                l(event);
            }
            catch { /* listener errors must not break the store */ }
        }
    }
    async flush() {
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
        }
        if (!this.dirty)
            return this.flushPromise;
        this.dirty = false;
        const data = JSON.stringify(this.bulkExport(), null, 2);
        const tmp = this.filePath + ".tmp";
        this.flushPromise = (async () => {
            await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.promises.writeFile(tmp, data, "utf-8");
            await fs.promises.rename(tmp, this.filePath);
        })();
        return this.flushPromise;
    }
    /**
     * Coalesce multiple in-flight changes into a single disk write. Call after
     * each mutation when the user is actively editing — replaces the previous
     * scheduled flush. Explicit `flush()` drains immediately.
     */
    scheduleFlush(delayMs = 500) {
        if (this.scheduledTimer)
            clearTimeout(this.scheduledTimer);
        this.scheduledTimer = setTimeout(() => {
            this.scheduledTimer = null;
            void this.flush().catch((err) => {
                console.warn("LabelStore scheduled flush failed:", err);
            });
        }, delayMs);
    }
    markDirty() {
        this.dirty = true;
    }
    loadFromDisk() {
        if (!fs.existsSync(this.filePath))
            return;
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, "utf-8");
        }
        catch {
            // Unreadable — leave store empty, file will be overwritten on next flush
            return;
        }
        try {
            const data = JSON.parse(raw);
            for (const [k, v] of Object.entries(data.classes ?? {}))
                this.classes.set(k, v);
            for (const [k, v] of Object.entries(data.methods ?? {}))
                this.methods.set(k, v);
            for (const [k, v] of Object.entries(data.fields ?? {}))
                this.fields.set(k, v);
        }
        catch {
            // Corrupted JSON — back up the file and start fresh
            const backup = `${this.filePath}.corrupted.${Date.now()}.json`;
            try {
                fs.renameSync(this.filePath, backup);
            }
            catch {
                // Couldn't rename; nothing we can do, leave the corrupted file as-is
                return;
            }
            this.classes.clear();
            this.methods.clear();
            this.fields.clear();
            if (this.onCorruption) {
                try {
                    this.onCorruption(backup);
                }
                catch { /* ignore */ }
            }
        }
    }
    lookup(key) {
        switch (key.kind) {
            case "class": return this.classes.get(key.className);
            case "method": return this.methods.get(`${key.className}.${key.methodName}`);
            case "field": return this.fields.get(`${key.className}.${key.fieldName}`);
        }
    }
    put(key, entry) {
        switch (key.kind) {
            case "class":
                this.classes.set(key.className, entry);
                break;
            case "method":
                this.methods.set(`${key.className}.${key.methodName}`, entry);
                break;
            case "field":
                this.fields.set(`${key.className}.${key.fieldName}`, entry);
                break;
        }
    }
    delete(key) {
        switch (key.kind) {
            case "class":
                this.classes.delete(key.className);
                break;
            case "method":
                this.methods.delete(`${key.className}.${key.methodName}`);
                break;
            case "field":
                this.fields.delete(`${key.className}.${key.fieldName}`);
                break;
        }
    }
}
exports.LabelStore = LabelStore;
//# sourceMappingURL=labels.js.map