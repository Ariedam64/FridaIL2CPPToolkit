import { describe, it, expect } from "vitest";

import { parseSearchInput, filterByKind, type IndexEntry } from "../../../backend/core/search-filters";

const entry = (kind: IndexEntry["kind"], label: string): IndexEntry => ({
    kind, label, description: "", detail: "",
    target: { command: "noop", args: [] },
});

describe("parseSearchInput", () => {
    it("returns null kind for plain queries", () => {
        expect(parseSearchInput("hello")).toEqual({ kind: null, query: "hello" });
    });

    it("recognises :class prefix", () => {
        expect(parseSearchInput(":class hello")).toEqual({ kind: "class", query: "hello" });
    });

    it("recognises :method prefix", () => {
        expect(parseSearchInput(":method foo")).toEqual({ kind: "method", query: "foo" });
    });

    it("recognises :field prefix", () => {
        expect(parseSearchInput(":field bar")).toEqual({ kind: "field", query: "bar" });
    });

    it("strips prefix even when followed only by spaces", () => {
        expect(parseSearchInput(":class ")).toEqual({ kind: "class", query: "" });
    });

    it("treats bare prefix without trailing space as empty query", () => {
        expect(parseSearchInput(":class")).toEqual({ kind: "class", query: "" });
    });

    it("ignores unknown prefixes", () => {
        expect(parseSearchInput(":rva 0x1234")).toEqual({ kind: null, query: ":rva 0x1234" });
    });

    it("does not match prefix mid-string", () => {
        expect(parseSearchInput("foo :class bar")).toEqual({ kind: null, query: "foo :class bar" });
    });
});

describe("filterByKind", () => {
    const items: IndexEntry[] = [
        entry("class", "A"),
        entry("class", "B"),
        entry("method", "m1"),
        entry("field", "f1"),
    ];

    it("returns all items when kind is null", () => {
        expect(filterByKind(items, null)).toEqual(items);
    });

    it("filters to classes", () => {
        expect(filterByKind(items, "class").map((e) => e.label)).toEqual(["A", "B"]);
    });

    it("filters to methods", () => {
        expect(filterByKind(items, "method").map((e) => e.label)).toEqual(["m1"]);
    });

    it("filters to fields", () => {
        expect(filterByKind(items, "field").map((e) => e.label)).toEqual(["f1"]);
    });
});
