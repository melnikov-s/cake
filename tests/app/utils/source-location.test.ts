import { describe, expect, it } from "vitest";
import { formatSourceLocation, parseSourceLocation } from "../../../src/utils/source-location";

describe("parseSourceLocation", () => {
  it.each([
    ["src/main.ts", { path: "src/main.ts" }],
    ["src/main.ts:880", { path: "src/main.ts", range: { start: { line: 879 } } }],
    ["src/main.ts:880:12", { path: "src/main.ts", range: { start: { line: 879, column: 11 } } }],
    [
      "src/main.ts#L880-L892",
      {
        path: "src/main.ts",
        range: { start: { line: 879 }, end: { line: 891 } },
      },
    ],
    ["main.ts:2", { path: "main.ts", range: { start: { line: 1 } } }],
    [
      "src/main.ts#L153-L170,L182-L192",
      {
        path: "src/main.ts",
        ranges: [
          { start: { line: 152 }, end: { line: 169 } },
          { start: { line: 181 }, end: { line: 191 } },
        ],
      },
    ],
    [
      "src/main.ts?view=changes#L55-L64",
      {
        path: "src/main.ts",
        view: "changes",
        range: { start: { line: 54 }, end: { line: 63 } },
      },
    ],
    [
      "src/main.ts?view=changes&side=before#L55-L64",
      {
        path: "src/main.ts",
        view: "changes",
        side: "before",
        range: { start: { line: 54 }, end: { line: 63 } },
      },
    ],
    [
      "src/main.ts?view=changes&base=main#L55-L64",
      {
        path: "src/main.ts",
        view: "changes",
        base: "main",
        range: { start: { line: 54 }, end: { line: 63 } },
      },
    ],
    [
      "src/main.ts?view=changes&side=before&base=origin%2Fmain#L55",
      {
        path: "src/main.ts",
        view: "changes",
        side: "before",
        base: "origin/main",
        range: { start: { line: 54 }, end: { line: 54 } },
      },
    ],
    [
      "src/main.ts?view=changes&base=HEAD~1",
      { path: "src/main.ts", view: "changes", base: "HEAD~1" },
    ],
    [
      "src/main.ts?view=changes#L55-L64,L80-L82",
      {
        path: "src/main.ts",
        view: "changes",
        ranges: [
          { start: { line: 54 }, end: { line: 63 } },
          { start: { line: 79 }, end: { line: 81 } },
        ],
      },
    ],
  ])("parses %s", (reference, expected) => {
    expect(parseSourceLocation(reference)).toEqual(expected);
  });

  it("rejects web URLs and invalid positions", () => {
    expect(parseSourceLocation("https://example.com/main.ts:2")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts:0")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts#L4-L2")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts#L4-L6,8-L9")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts?view=changes&side=base#L4")).toBeUndefined();
  });

  it("rejects changes links whose base is not a single safe Git revision", () => {
    for (const base of ["--output=x", "main..HEAD", "HEAD:src/main.ts", "a%20b", "", "%E0%A4%A"]) {
      expect(parseSourceLocation(`src/main.ts?view=changes&base=${base}#L4`)).toBeUndefined();
    }
    expect(parseSourceLocation("src/main.ts?view=changes&base=main&base=dev#L4")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts?view=changes&other=1#L4")).toBeUndefined();
  });

  it("round-trips changes links with a base revision", () => {
    const location = {
      path: "src/main.ts",
      view: "changes" as const,
      side: "before" as const,
      base: "origin/main",
      range: { start: { line: 54 }, end: { line: 63 } },
    };
    const formatted = formatSourceLocation(location);
    expect(formatted).toBe("src/main.ts?view=changes&side=before&base=origin%2Fmain#L55-L64");
    expect(parseSourceLocation(formatted)).toEqual(location);
  });

  it("formats multiple ranges as one source link", () => {
    expect(
      formatSourceLocation({
        path: "src/main.ts",
        ranges: [
          { start: { line: 152 }, end: { line: 169 } },
          { start: { line: 181 }, end: { line: 191 } },
        ],
      }),
    ).toBe("src/main.ts#L153-L170,L182-L192");
  });
});
