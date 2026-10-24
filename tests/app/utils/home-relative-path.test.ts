import { describe, expect, it } from "vitest";
import { toHomeRelativePath } from "../../../src/utils/home-relative-path";

describe("toHomeRelativePath", () => {
  it.each([
    ["/home/alex/file.ts", "/home/alex", "~/file.ts"],
    ["/home/alex/file.ts", "/home/alex/", "~/file.ts"],
    ["/home/alex", "/home/alex", "~"],
    ["/home/alexander/file.ts", "/home/alex", "/home/alexander/file.ts"],
    ["/home/other/file.ts", "/home/alex", "/home/other/file.ts"],
    ["src/file.ts", "/home/alex", "src/file.ts"],
    ["~/file.ts", "/home/alex", "~/file.ts"],
    ["/home/alex/file.ts", undefined, "/home/alex/file.ts"],
  ])("displays %s with home %s as %s", (path, home, expected) => {
    expect(toHomeRelativePath(path, home)).toBe(expected);
  });
});
