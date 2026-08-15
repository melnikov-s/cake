import { describe, expect, it } from "vitest";
import { parseInlineWidgets } from "../../../src/renderer/components/inline-widget";

describe("inline Cake widget fences", () => {
  it("keeps Markdown around closed HTML and React widgets in source order", () => {
    const parts = parseInlineWidgets("Before\n\n```cake-html\n<strong>Hi</strong>\n```\n\nBetween\n\n```cake-react\nexport default () => <b>Hi</b>\n```\n\nAfter");

    expect(parts).toEqual([
      { kind: "markdown", text: "Before\n\n" },
      { kind: "widget", language: "html", source: "<strong>Hi</strong>", closed: true, index: 0 },
      { kind: "markdown", text: "\nBetween\n\n" },
      { kind: "widget", language: "react", source: "export default () => <b>Hi</b>", closed: true, index: 1 },
      { kind: "markdown", text: "\nAfter" }
    ]);
  });

  it("represents an unfinished streaming fence as a building widget", () => {
    expect(parseInlineWidgets("Intro\n```cake-html\n<div>still streaming")).toEqual([
      { kind: "markdown", text: "Intro\n" },
      { kind: "widget", language: "html", source: "<div>still streaming", closed: false, index: 0 }
    ]);
  });
});
