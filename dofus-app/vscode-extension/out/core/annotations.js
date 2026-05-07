"use strict";
// Annotation store: bookmarks + notes per class/method/field.
// File-backed JSON. Same Listener pattern as labels.ts.
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
exports.AnnotationStore = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function keyId(key) {
    switch (key.kind) {
        case "class": return `class:${key.className}`;
        case "method": return `method:${key.className}.${key.methodName}`;
        case "field": return `field:${key.className}.${key.fieldName}`;
    }
}
function parseKeyId(id) {
    const m = /^(class|method|field):(.+)$/.exec(id);
    if (!m)
        return null;
    const kind = m[1];
    const rest = m[2];
    if (kind === "class")
        return { kind, className: rest };
    const dot = rest.indexOf(".");
    if (dot < 0)
        return null;
    const className = rest.slice(0, dot);
    const member = rest.slice(dot + 1);
    return kind === "method"
        ? { kind, className, methodName: member }
        : { kind, className, fieldName: member };
}
class AnnotationStore {
    bookmarks = new Map();
    notes = new Map();
    listeners = [];
    filePath;
    dirty = false;
    scheduledTimer = null;
    onCorruption;
    constructor(filePath, onCorruption) {
        this.filePath = filePath;
        this.onCorruption = onCorruption;
        this.loadFromDisk();
    }
    isBookmarked(key) {
        return this.bookmarks.has(keyId(key));
    }
    bookmarkCount() { return this.bookmarks.size; }
    noteCount() { return this.notes.size; }
    toggleBookmark(key) {
        const id = keyId(key);
        if (this.bookmarks.has(id)) {
            this.bookmarks.delete(id);
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "removed" });
        }
        else {
            this.bookmarks.set(id, { createdAt: new Date().toISOString() });
            this.markDirty();
            this.emit({ key, kind: "bookmark", action: "added" });
        }
    }
    listBookmarks() {
        return Array.from(this.bookmarks.keys())
            .map(parseKeyId)
            .filter((k) => k !== null);
    }
    getNote(key) {
        return this.notes.get(keyId(key))?.markdown ?? null;
    }
    setNote(key, markdown) {
        const id = keyId(key);
        const exists = this.notes.has(id);
        this.notes.set(id, { markdown, updatedAt: new Date().toISOString() });
        this.markDirty();
        this.emit({ key, kind: "note", action: exists ? "updated" : "added" });
    }
    removeNote(key) {
        const id = keyId(key);
        if (!this.notes.has(id))
            return;
        this.notes.delete(id);
        this.markDirty();
        this.emit({ key, kind: "note", action: "removed" });
    }
    listNoted() {
        return Array.from(this.notes.keys())
            .map(parseKeyId)
            .filter((k) => k !== null);
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
            catch { /* swallow */ }
        }
    }
    async flush() {
        if (this.scheduledTimer) {
            clearTimeout(this.scheduledTimer);
            this.scheduledTimer = null;
        }
        if (!this.dirty)
            return;
        this.dirty = false;
        const data = {
            schemaVersion: 1,
            bookmarks: Object.fromEntries(this.bookmarks),
            notes: Object.fromEntries(this.notes),
        };
        const tmp = this.filePath + ".tmp";
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
        await fs.promises.rename(tmp, this.filePath);
    }
    /** Same contract as LabelStore.scheduleFlush — debounce repeated edits. */
    scheduleFlush(delayMs = 500) {
        if (this.scheduledTimer)
            clearTimeout(this.scheduledTimer);
        this.scheduledTimer = setTimeout(() => {
            this.scheduledTimer = null;
            void this.flush().catch((err) => {
                console.warn("AnnotationStore scheduled flush failed:", err);
            });
        }, delayMs);
    }
    markDirty() { this.dirty = true; }
    loadFromDisk() {
        if (!fs.existsSync(this.filePath))
            return;
        let raw;
        try {
            raw = fs.readFileSync(this.filePath, "utf-8");
        }
        catch {
            return;
        }
        try {
            const data = JSON.parse(raw);
            for (const [k, v] of Object.entries(data.bookmarks ?? {}))
                this.bookmarks.set(k, v);
            for (const [k, v] of Object.entries(data.notes ?? {}))
                this.notes.set(k, v);
        }
        catch {
            const backup = `${this.filePath}.corrupted.${Date.now()}.json`;
            try {
                fs.renameSync(this.filePath, backup);
            }
            catch {
                return;
            }
            this.bookmarks.clear();
            this.notes.clear();
            if (this.onCorruption) {
                try {
                    this.onCorruption(backup);
                }
                catch { /* ignore */ }
            }
        }
    }
}
exports.AnnotationStore = AnnotationStore;
//# sourceMappingURL=annotations.js.map