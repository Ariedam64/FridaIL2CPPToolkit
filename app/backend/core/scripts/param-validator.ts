import type { ParamSchema, ParamSpec } from "./types";

export type ValidationResult =
    | { ok: true;  values: Record<string, unknown> }
    | { ok: false; error: string };

export function validateParamValues(
    schema: ParamSchema,
    raw: Record<string, unknown>,
): ValidationResult {
    const out: Record<string, unknown> = {};

    // Reject extra params not in schema (no silent extras).
    for (const k of Object.keys(raw)) {
        if (!(k in schema)) return { ok: false, error: `unknown param: ${k}` };
    }

    for (const [key, spec] of Object.entries(schema)) {
        const present = key in raw;
        const value = raw[key];

        if (present && value === null) {
            return { ok: false, error: `${key}: null is not a valid value` };
        }
        if (!present || value === undefined) {
            if ("default" in spec && spec.default !== undefined) {
                out[key] = spec.default;
                continue;
            }
            if ("required" in spec && spec.required) {
                return { ok: false, error: `missing required param: ${key}` };
            }
            continue;  // optional, no default → omit
        }

        const err = validateOne(key, spec, value);
        if (err) return { ok: false, error: err };
        out[key] = value;
    }

    return { ok: true, values: out };
}

function validateOne(key: string, spec: ParamSpec, value: unknown): string | null {
    switch (spec.type) {
        case "string":
            if (typeof value !== "string") return `${key} expected string, got ${typeof value}`;
            return null;
        case "number":
            if (typeof value !== "number") return `${key} expected number, got ${typeof value}`;
            if (!Number.isFinite(value)) return `${key} expected finite number, got ${String(value)}`;
            if (spec.min !== undefined && value < spec.min) return `${key} below min ${spec.min}`;
            if (spec.max !== undefined && value > spec.max) return `${key} above max ${spec.max}`;
            return null;
        case "boolean":
            if (typeof value !== "boolean") return `${key} expected boolean, got ${typeof value}`;
            return null;
        case "enum":
            if (typeof value !== "string") return `${key} expected string (enum), got ${typeof value}`;
            if (!spec.values.includes(value)) return `${key} value '${value}' not in [${spec.values.join(", ")}]`;
            return null;
    }
}
