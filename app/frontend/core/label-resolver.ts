// Single source of truth for class/field/method label resolution in the
// frontend. Loads the labels store once on first use, subscribes to WS
// `label-change` events to stay in sync, exposes lazy resolvers + a
// change-notification callback so views can rerender when renames happen.

import { api } from "./api.js";
import { subscribe } from "./ws.js";

interface LabelsShape {
    schemaVersion?: number;
    classes: Record<string, { label: string }>;
    methods: Record<string, { label: string }>;
    fields: Record<string, { label: string }>;
}

let labels: LabelsShape = { classes: {}, methods: {}, fields: {} };
let initPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
    for (const l of listeners) {
        try { l(); } catch (e) { console.error(e); }
    }
}

async function refresh(): Promise<void> {
    try {
        const fresh = (await api.getLabels()) as LabelsShape;
        labels = {
            classes: fresh.classes ?? {},
            methods: fresh.methods ?? {},
            fields: fresh.fields ?? {},
        };
    } catch {
        labels = { classes: {}, methods: {}, fields: {} };
    }
    notify();
}

function ensureInit(): Promise<void> {
    if (!initPromise) initPromise = refresh();
    return initPromise;
}

// Patch state in-place from WS events to avoid round-trip on every rename.
subscribe("label-change", (evt: { key: { kind: string; className: string; fieldName?: string; methodName?: string }; newLabel: string | null }) => {
    if (!evt || !evt.key) return;
    const k = evt.key;
    if (k.kind === "class") {
        if (evt.newLabel === null) delete labels.classes[k.className];
        else labels.classes[k.className] = { label: evt.newLabel };
    } else if (k.kind === "field" && k.fieldName) {
        const id = `${k.className}.${k.fieldName}`;
        if (evt.newLabel === null) delete labels.fields[id];
        else labels.fields[id] = { label: evt.newLabel };
    } else if (k.kind === "method" && k.methodName) {
        const id = `${k.className}.${k.methodName}`;
        if (evt.newLabel === null) delete labels.methods[id];
        else labels.methods[id] = { label: evt.newLabel };
    }
    notify();
});

// Reset state on profile lifecycle so we don't leak labels across profiles.
subscribe("profile-attached", () => { initPromise = null; void ensureInit(); });
subscribe("profile-detached", () => {
    labels = { classes: {}, methods: {}, fields: {} };
    initPromise = null;
    notify();
});

/** Returns the friendly label if set, else the obfuscated name verbatim. */
export function resolveClass(className: string): string {
    return labels.classes[className]?.label ?? className;
}

/** Returns the friendly field label if set, else the obfuscated field name. */
export function resolveField(className: string, fieldName: string): string {
    return labels.fields[`${className}.${fieldName}`]?.label ?? fieldName;
}

/** Returns the friendly method label if set, else the obfuscated method name. */
export function resolveMethod(className: string, methodName: string): string {
    return labels.methods[`${className}.${methodName}`]?.label ?? methodName;
}

/** True if a class has been renamed (useful for showing obf as suffix). */
export function hasClassLabel(className: string): boolean {
    return labels.classes[className] !== undefined;
}

/** True if a field has been renamed. */
export function hasFieldLabel(className: string, fieldName: string): boolean {
    return labels.fields[`${className}.${fieldName}`] !== undefined;
}

/** Subscribe to label-state changes. Returns disposer. Triggers initial fetch. */
export function onLabelsChange(cb: () => void): () => void {
    listeners.add(cb);
    void ensureInit();
    return () => { listeners.delete(cb); };
}

// Eager init: kick off the fetch when the module is first imported, so the
// first render has labels available without waiting for an explicit subscriber.
void ensureInit();
