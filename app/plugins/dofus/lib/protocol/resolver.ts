// Resolve a protocol spec (classes/fields/methods) against the LabelStore.
// Falls back to the spec's `fallback` field when no label exists yet.

import type { LabelStore } from "../../../../backend/core/labels";
import type { ProtoClassSpec, ProtoMemberSpec } from "./schema";

interface AnyProtoSpec {
    classes: Record<string, ProtoClassSpec>;
    fields:  Record<string, ProtoMemberSpec>;
    methods: Record<string, ProtoMemberSpec>;
}

interface ResolvedSpec {
    classes: Record<string, string>;
    fields:  Record<string, string>;
    methods: Record<string, string>;
}

export function resolveProto<S extends AnyProtoSpec>(labels: LabelStore, spec: S): ResolvedSpec {
    const classes: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.classes)) {
        classes[k] = labels.resolveByLabel("class", v.friendly) ?? v.fallback;
    }

    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.fields)) {
        const classObf = classes[v.classKey];
        if (!classObf) { fields[k] = v.fallback; continue; }
        fields[k] = labels.resolveByLabel("field", v.friendly, classObf) ?? v.fallback;
    }

    const methods: Record<string, string> = {};
    for (const [k, v] of Object.entries(spec.methods)) {
        const classObf = classes[v.classKey];
        if (!classObf) { methods[k] = v.fallback; continue; }
        methods[k] = labels.resolveByLabel("method", v.friendly, classObf) ?? v.fallback;
    }

    return { classes, fields, methods };
}
