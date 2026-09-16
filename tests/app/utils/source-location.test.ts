import { describe, expect, it } from "vitest";
import { parseSourceLocation } from "../../../src/utils/source-location";

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
  ])("parses %s", (reference, expected) => {
    expect(parseSourceLocation(reference)).toEqual(expected);
  });

  it("rejects web URLs and invalid positions", () => {
    expect(parseSourceLocation("https://example.com/main.ts:2")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts:0")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts#L4-L2")).toBeUndefined();
    expect(parseSourceLocation("src/main.ts?view=changes&side=base#L4")).toBeUndefined();
  });
});
