import { describe, it, expect } from "vitest";

import { matchFingerprints } from "../../../backend/core/migrations";
import type { ClassFingerprint } from "../../../backend/core/types";

const cls = (
    obfName: string,
    overrides: Partial<ClassFingerprint> = {},
): ClassFingerprint => ({
    obfName,
    token: null,
    parents: [],
    methodCount: 0,
    fields: [],
    methods: [],
    ...overrides,
});

// Convert the old test helper format (fieldTypes: ["x:int"]) to
// FieldFingerprint[] for tests written before v1.3.
const fieldsFromTypes = (specs: string[]): import("../../../backend/core/types").FieldFingerprint[] =>
    specs.map((s, i) => {
        const [name, type] = s.split(":");
        return {
            obfName: name,
            typeName: type,
            declIndex: i,
            isStatic: false,
            isPublic: true,
        };
    });

// Convert ["a(int)int", "b(string)bool"] to MethodFingerprint[].
const methodsFromSigs = (sigs: string[]): import("../../../backend/core/types").MethodFingerprint[] =>
    sigs.map((sig, i) => {
        const m = sig.match(/^(\w+)\(([^)]*)\)(.+)$/);
        if (!m) throw new Error(`bad sig: ${sig}`);
        const [, name, paramsRaw, ret] = m;
        const paramTypes = paramsRaw === "" ? [] : paramsRaw.split(",");
        return {
            obfName: name,
            token: null,
            paramTypes,
            returnType: ret,
            paramCount: paramTypes.length,
            declIndex: i,
            isStatic: false,
        };
    });

describe("matchFingerprints", () => {
    it("auto-migrates when token matches exactly", () => {
        const oldFps = [cls("egq", { token: "0x2001A5E", methodCount: 17 })];
        const newFps = [cls("dxr", { token: "0x2001A5E", methodCount: 17 })];
        const labels: Record<string, string> = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].oldObf).toBe("egq");
        expect(result.auto[0].newObf).toBe("dxr");
        expect(result.auto[0].label).toBe("HaapiService");
        expect(result.auto[0].reason).toContain("token");
    });

    it("auto-migrates when fingerprint score is >= 0.95 (unique candidate)", () => {
        const oldFps = [cls("egq", {
            token: null,
            parents: ["base1"],
            methodCount: 17,
            methods: methodsFromSigs(["a(int)int", "b(string)bool", "c()void"]),
            fields: fieldsFromTypes(["x:int", "y:string"]),
        })];
        const newFps = [
            cls("dxr", {
                token: null,
                parents: ["base1"],
                methodCount: 17,
                methods: methodsFromSigs(["a(int)int", "b(string)bool", "c()void"]),
                fields: fieldsFromTypes(["x:int", "y:string"]),
            }),
            cls("zzz", {
                token: null,
                parents: ["unrelated"],
                methodCount: 5,
                methods: methodsFromSigs(["different()void"]),
                fields: fieldsFromTypes([]),
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].newObf).toBe("dxr");
    });

    it("flags review when multiple candidates score >= 0.60 but none reaches 0.95", () => {
        const oldFps = [cls("egq", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
            fields: fieldsFromTypes(["x:int"]),
        })];
        const newFps = [
            cls("aaa", {
                methodCount: 5,
                methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
                fields: fieldsFromTypes(["x:long"]),
            }),
            cls("bbb", {
                methodCount: 5,
                methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "f()void"]),
                fields: fieldsFromTypes(["x:int"]),
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.review.length).toBeGreaterThanOrEqual(1);
        expect(result.review[0].oldObf).toBe("egq");
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(2);
    });

    it("marks lost when no candidate matches above 0.60", () => {
        const oldFps = [cls("egq", {
            methodCount: 17,
            methods: methodsFromSigs(["specific()void"]),
            fields: fieldsFromTypes(["uniqueField:int"]),
        })];
        const newFps = [
            cls("aaa", {
                methodCount: 1,
                methods: methodsFromSigs(["totally_different()void"]),
                fields: fieldsFromTypes(["other:string"]),
            }),
        ];
        const labels = { egq: "HaapiService" };

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].oldObf).toBe("egq");
    });

    it("ignores classes with no label set", () => {
        const oldFps = [cls("egq", { token: "0x123" })];
        const newFps = [cls("dxr", { token: "0x123" })];
        const labels = {};

        const result = matchFingerprints({ oldFps, newFps, oldLabels: labels });

        expect(result.auto).toHaveLength(0);
        expect(result.review).toHaveLength(0);
        expect(result.lost).toHaveLength(0);
    });
});
