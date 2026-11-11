import { expect, it } from "vitest";
import { PREVIEW_MAX_CHARACTERS, textPreview } from "../../../src/renderer/lib/text-preview";

it("leaves short text unchanged", () => {
  expect(textPreview("Inspect the boundary")).toBe("Inspect the boundary");
});

it("collapses newlines and whitespace runs into single spaces", () => {
  expect(textPreview("  Read-only investigation.\n\n- Find the bug\r\n\t- Report back  ")).toBe(
    "Read-only investigation. - Find the bug - Report back",
  );
});

it("caps long text at the medium preview length with an ellipsis", () => {
  const preview = textPreview(`${"word ".repeat(400)}tail`);
  expect(preview).toHaveLength(PREVIEW_MAX_CHARACTERS);
  expect(preview.endsWith("word…")).toBe(true);
  expect(preview).not.toContain("tail");
  expect(textPreview("x".repeat(10), 10)).toBe("x".repeat(10));
  expect(textPreview("x".repeat(11), 10)).toBe(`${"x".repeat(9)}…`);
});

it("never splits a surrogate pair at the cut", () => {
  expect(textPreview(`${"a".repeat(8)}😀😀`, 10)).toBe(`${"a".repeat(8)}…`);
});
