import { describe, expect, it } from "vitest";
import {
  formatDrawSourceLink,
  isCakeDrawSourceUrl,
  parseDrawSourceLink,
} from "../../../src/domain/draw/draw-source-link";

describe("Cake Draw source links", () => {
  it("round-trips a Working Directory-relative path and exact range", () => {
    const location = {
      path: "src/components/draw canvas.tsx",
      range: {
        start: { line: 14, column: 3 },
        end: { line: 22, column: 9 },
      },
    };

    const link = formatDrawSourceLink(location);

    expect(link).toBe(
      "https://cake.invalid/draw/source?path=src%2Fcomponents%2Fdraw+canvas.tsx&line=15&column=4&endLine=23&endColumn=10",
    );
    expect(parseDrawSourceLink(link)).toEqual(location);
  });

  it("supports a file without a range and a line-only range", () => {
    expect(parseDrawSourceLink(formatDrawSourceLink({ path: "README.md" }))).toEqual({
      path: "README.md",
    });
    expect(
      parseDrawSourceLink(
        formatDrawSourceLink({ path: "src/app.ts", range: { start: { line: 6 } } }),
      ),
    ).toEqual({ path: "src/app.ts", range: { start: { line: 6 } } });
  });

  it.each([
    "https://cake.invalid/draw/source?path=../secret.ts",
    "https://cake.invalid/draw/source?path=src%2F..%2Fsecret.ts",
    "https://cake.invalid/draw/source?path=%2Fetc%2Fpasswd",
    "https://cake.invalid/draw/source?path=C%3A%5Csecret.ts",
    "https://cake.invalid/draw/source?path=src%2Fapp.ts&line=0",
    "https://cake.invalid/draw/source?path=src%2Fapp.ts&column=2",
    "https://cake.invalid/draw/source?path=src%2Fapp.ts&line=8&endLine=4",
    "https://cake.invalid/draw/source?path=src%2Fapp.ts&command=workbench.action.terminal.new",
    "https://cake.invalid/draw/source?path=src%2Fa.ts&path=src%2Fb.ts",
    "https://cake.invalid/draw/source?path=src%2Fapp.ts#L4",
    "javascript:alert(1)",
  ])("rejects malformed or unsafe reference %s", (reference) => {
    expect(parseDrawSourceLink(reference)).toBeUndefined();
  });

  it("identifies malformed Cake links without claiming ordinary links", () => {
    expect(isCakeDrawSourceUrl("https://cake.invalid/draw/source?path=../secret.ts")).toBe(true);
    expect(isCakeDrawSourceUrl("https://example.com/docs")).toBe(false);
  });
});
