import { describe, it, expect } from "vitest";

import { matchFingerprints, matchClassMembers } from "../../../backend/core/migrations";
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

    it("auto-migrates via structural fingerprint when token is absent (obf rotation)", () => {
        // Old class had label "MovementController", no token, but its
        // structural FP was captured at rename time. After update the class
        // has a different obf name, no token, but the same structural FP.
        const oldFps = [cls("dve", {
            token: null,
            methodCount: 5,
            fields: fieldsFromTypes(["dezt:Core.Rendering.Entity.Entity"]),
            methods: methodsFromSigs(["txh(fpf)void"]),
        })];
        const newFps = [cls("xyz", {
            token: null,
            methodCount: 5,
            fields: fieldsFromTypes(["aaa:Core.Rendering.Entity.Entity"]),
            methods: methodsFromSigs(["bbb(fpf)void"]),
            structuralFp: "DEADBEEF",
        })];

        const result = matchFingerprints({
            oldFps, newFps,
            oldLabels: { dve: "MovementController" },
            oldLabelFingerprints: { dve: "DEADBEEF" },
        });

        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].oldObf).toBe("dve");
        expect(result.auto[0].newObf).toBe("xyz");
        expect(result.auto[0].reason).toContain("structural fingerprint");
    });

    it("falls through to similarity when structural FP collides on the new side", () => {
        // Two new classes share the FP — engine should NOT auto-resolve on FP
        // alone and instead let the similarity-scoring path decide.
        const oldFps = [cls("dve", {
            token: null,
            methodCount: 1,
            fields: fieldsFromTypes(["a:Foo"]),
            methods: methodsFromSigs(["m()void"]),
        })];
        const newFps = [
            cls("xyz", { token: null, methodCount: 1,
                fields: fieldsFromTypes(["a:Foo"]),
                methods: methodsFromSigs(["m()void"]),
                structuralFp: "COLLIDE" }),
            cls("abc", { token: null, methodCount: 1,
                fields: fieldsFromTypes(["unrelated:Bar"]),
                methods: methodsFromSigs(["other()int"]),
                structuralFp: "COLLIDE" }),
        ];

        const result = matchFingerprints({
            oldFps, newFps,
            oldLabels: { dve: "MovementController" },
            oldLabelFingerprints: { dve: "COLLIDE" },
        });

        // Whichever path picks the winner, the FP fast-path itself MUST NOT
        // claim the auto-resolution — that's what we're asserting.
        const fpAuto = result.auto.find((a) => a.reason.includes("structural fingerprint"));
        expect(fpAuto).toBeUndefined();
    });
});

describe("matchClassMembers — fields (STRICT)", () => {
    const oldCls = cls("oldA", {
        fields: [
            { obfName: "emjv", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
            { obfName: "emkh", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            { obfName: "emkj", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
        ],
    });

    it("AUTO when type is unique on both sides", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "aaa", typeName: "System.Int64", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "bbb", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "ccc", typeName: "System.Int64", declIndex: 2, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emkh": "userName" });
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "field", className: "newA", fieldName: "bbb" });
        expect(result.auto[0].reason).toContain("unique type match");
        expect(result.auto[0].parentClassMigration).toBe("oldA");
    });

    it("AUTO when type N×N with declIndex aligned (type+ordinal)", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "p", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "q", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "r", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(
            oldCls,
            newCls,
            {},
            { "oldA.emjv": "playerId", "oldA.emkj": "mapId" },
        );
        expect(result.auto).toHaveLength(2);
        const playerIdRec = result.auto.find((r) => r.label === "playerId")!;
        expect(playerIdRec.key).toEqual({ kind: "field", className: "newA", fieldName: "p" });
        expect(playerIdRec.reason).toContain("type+ordinal");
        const mapIdRec = result.auto.find((r) => r.label === "mapId")!;
        expect(mapIdRec.key).toEqual({ kind: "field", className: "newA", fieldName: "r" });
    });

    it("REVIEW when type count changes (N != M)", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "a", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "b", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
                { obfName: "c", typeName: "System.Int32", declIndex: 2, isStatic: false, isPublic: true },
                { obfName: "d", typeName: "System.Int32", declIndex: 3, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emjv": "playerId" });
        expect(result.review).toHaveLength(1);
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(2);
        expect(result.review[0].candidates.length).toBeLessThanOrEqual(5);
        expect(result.review[0].candidates[0].reason).toContain("type System.Int32 count changed");
    });

    it("LOST when type disappears", () => {
        const newCls = cls("newA", {
            fields: [
                { obfName: "x", typeName: "System.Single", declIndex: 0, isStatic: false, isPublic: true },
            ],
        });
        const result = matchClassMembers(oldCls, newCls, {}, { "oldA.emjv": "playerId" });
        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].reason).toContain("type System.Int32 disappeared");
        expect(result.lost[0].parentClassMigration).toBe("oldA");
    });
});

describe("matchClassMembers — methods (LENIENT)", () => {
    const mkMethod = (overrides: Partial<import("../../../backend/core/types").MethodFingerprint> = {}): import("../../../backend/core/types").MethodFingerprint => ({
        obfName: "x",
        token: null,
        paramTypes: [],
        returnType: "System.Void",
        paramCount: 0,
        declIndex: 0,
        isStatic: false,
        ...overrides,
    });

    it("AUTO when token matches", () => {
        const oldCls = cls("oldA", { methods: [mkMethod({ obfName: "vto", token: "0x600A1B2" })] });
        const newCls = cls("newA", { methods: [mkMethod({ obfName: "abc", token: "0x600A1B2" })] });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "method", className: "newA", methodName: "abc" });
        expect(result.auto[0].reason).toBe("token match");
    });

    it("AUTO when full signature exact + name preserved + unique", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "Encode", paramTypes: ["int", "string"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "Encode", paramTypes: ["int", "string"], returnType: "void" }),
                mkMethod({ obfName: "Other", paramTypes: ["bool"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.Encode": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].reason).toContain("exact signature, name preserved");
    });

    it("AUTO when signature without name is unique", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "string"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "abc", paramTypes: ["int", "string"], returnType: "void" }),
                mkMethod({ obfName: "def", paramTypes: ["bool"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.auto).toHaveLength(1);
        expect(result.auto[0].key).toEqual({ kind: "method", className: "newA", methodName: "abc" });
        expect(result.auto[0].reason).toContain("signature match, renamed method");
    });

    it("REVIEW when score 0.60-0.95 (multiple candidates)", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "int"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "a", paramTypes: ["int", "long"], returnType: "void" }),
                mkMethod({ obfName: "b", paramTypes: ["long", "int"], returnType: "void", declIndex: 1 }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.review.length).toBeGreaterThanOrEqual(1);
        expect(result.review[0].candidates.length).toBeGreaterThanOrEqual(1);
    });

    it("LOST when no candidate >= 0.60", () => {
        const oldCls = cls("oldA", {
            methods: [mkMethod({ obfName: "vto", paramTypes: ["int", "int", "int"], returnType: "void" })],
        });
        const newCls = cls("newA", {
            methods: [
                mkMethod({ obfName: "a", paramTypes: ["string"], returnType: "bool" }),
            ],
        });
        const result = matchClassMembers(oldCls, newCls, { "oldA.vto": "encode" }, {});
        expect(result.lost).toHaveLength(1);
        expect(result.lost[0].reason).toContain("no candidate above 0.60");
    });
});

describe("matchFingerprints — pass 2 (auto classes get fields/methods migrated)", () => {
    it("emits field+method records for an auto-migrated class", () => {
        const oldA = cls("oldA", {
            token: "0x100",
            methodCount: 1,
            methods: methodsFromSigs(["v(int)void"]),
            fields: fieldsFromTypes(["a:System.Int32"]),
        });
        const newA = cls("newA", {
            token: "0x100",
            methodCount: 1,
            methods: methodsFromSigs(["w(int)void"]),
            fields: fieldsFromTypes(["b:System.Int32"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA],
            oldLabels: { oldA: "Encoder" },
            oldMethodLabels: { "oldA.v": "encodeInt" },
            oldFieldLabels: { "oldA.a": "playerId" },
        });
        expect(result.auto.find((r) => r.key.kind === "class" && r.label === "Encoder")).toBeDefined();
        expect(result.auto.find((r) => r.key.kind === "method" && r.label === "encodeInt")).toBeDefined();
        expect(result.auto.find((r) => r.key.kind === "field" && r.label === "playerId")).toBeDefined();
    });

    it("does NOT emit member records for a class in REVIEW (suspended)", () => {
        const oldA = cls("oldA", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
            fields: fieldsFromTypes(["x:int"]),
        });
        const newA = cls("aaa", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "e()void"]),
            fields: fieldsFromTypes(["x:long"]),
        });
        const newB = cls("bbb", {
            methodCount: 5,
            methods: methodsFromSigs(["a()void", "b()void", "c()void", "d()void", "f()void"]),
            fields: fieldsFromTypes(["x:int"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA, newB],
            oldLabels: { oldA: "ClassA" },
            oldMethodLabels: { "oldA.a": "method_a" },
            oldFieldLabels: { "oldA.x": "fieldX" },
        });
        // Class is in REVIEW — no member records yet
        expect(result.review.length).toBe(1);
        expect(result.auto.filter((r) => r.key.kind === "method")).toHaveLength(0);
        expect(result.auto.filter((r) => r.key.kind === "field")).toHaveLength(0);
    });

    it("cascades fields/methods to LOST when their parent class is LOST", () => {
        const oldA = cls("oldA", {
            methodCount: 17,
            methods: methodsFromSigs(["specific()void"]),
            fields: fieldsFromTypes(["uniqueField:int"]),
        });
        const newA = cls("aaa", {
            methodCount: 1,
            methods: methodsFromSigs(["totally_different()void"]),
            fields: fieldsFromTypes(["other:string"]),
        });
        const result = matchFingerprints({
            oldFps: [oldA],
            newFps: [newA],
            oldLabels: { oldA: "ClassA" },
            oldMethodLabels: { "oldA.specific": "specificLabel" },
            oldFieldLabels: { "oldA.uniqueField": "fieldLabel" },
        });
        expect(result.lost.length).toBe(3); // class + method + field
        const memberLost = result.lost.filter((r) => r.key.kind !== "class");
        expect(memberLost).toHaveLength(2);
        expect(memberLost.every((r) => r.reason.includes("parent class lost"))).toBe(true);
    });
});

describe("matchFingerprints — full Dofus-like scenario", () => {
    it("encoder class with method+field labels migrates fully across builds", () => {
        const oldEncoder = cls("fzc", {
            token: "0x2001000",
            methodCount: 3,
            methods: [
                { obfName: "Encode", token: "0x600A001", paramTypes: ["IMessage"], returnType: "void", paramCount: 1, declIndex: 0, isStatic: false },
                { obfName: "Decode", token: "0x600A002", paramTypes: ["byte[]"], returnType: "IMessage", paramCount: 1, declIndex: 1, isStatic: false },
                { obfName: "Reset", token: "0x600A003", paramTypes: [], returnType: "void", paramCount: 0, declIndex: 2, isStatic: false },
            ],
            fields: [
                { obfName: "emjv", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "emkh", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            ],
        });
        const newEncoder = cls("xyz", {
            token: "0x2001000",
            methodCount: 3,
            methods: [
                { obfName: "a", token: "0x600A001", paramTypes: ["IMessage"], returnType: "void", paramCount: 1, declIndex: 0, isStatic: false },
                { obfName: "b", token: "0x600A002", paramTypes: ["byte[]"], returnType: "IMessage", paramCount: 1, declIndex: 1, isStatic: false },
                { obfName: "c", token: "0x600A003", paramTypes: [], returnType: "void", paramCount: 0, declIndex: 2, isStatic: false },
            ],
            fields: [
                { obfName: "p", typeName: "System.Int32", declIndex: 0, isStatic: false, isPublic: true },
                { obfName: "q", typeName: "System.String", declIndex: 1, isStatic: false, isPublic: true },
            ],
        });

        const result = matchFingerprints({
            oldFps: [oldEncoder],
            newFps: [newEncoder],
            oldLabels: { fzc: "Encoder" },
            oldMethodLabels: { "fzc.Encode": "encode", "fzc.Decode": "decode" },
            oldFieldLabels: { "fzc.emjv": "playerId", "fzc.emkh": "playerName" },
        });

        // 1 class auto + 2 method auto + 2 field auto = 5
        expect(result.auto).toHaveLength(5);
        expect(result.review).toHaveLength(0);
        expect(result.lost).toHaveLength(0);

        // Spot-check each migration
        const cls_ = result.auto.find((r) => r.key.kind === "class")!;
        expect(cls_.newObf).toBe("xyz");
        const playerIdRec = result.auto.find((r) => r.label === "playerId")!;
        expect(playerIdRec.key).toEqual({ kind: "field", className: "xyz", fieldName: "p" });
        const encodeRec = result.auto.find((r) => r.label === "encode")!;
        expect(encodeRec.key).toEqual({ kind: "method", className: "xyz", methodName: "a" });
        expect(encodeRec.reason).toBe("token match");
    });
});
