/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { selectionColumn } from "../../../src/renderer/components/source-review";

describe("source review selection", () => {
  it("excludes the rendered line prefix from review columns", () => {
    const code = document.createElement("code");
    const prefix = document.createElement("b");
    prefix.dataset.reviewPrefix = "";
    prefix.textContent = " ";
    const source = document.createTextNode("const cake = true;");
    code.append(prefix, source);

    expect(selectionColumn(code, source, 0)).toBe(0);
    expect(selectionColumn(code, source, 5)).toBe(5);
  });
});
