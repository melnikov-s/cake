import { describe, expect, it } from "vitest";
import { shouldRenderMarkdown } from "../../../src/utils/markdown";

describe("shouldRenderMarkdown", () => {
  it.each([
    "# Heading",
    "A **bold** choice",
    "Use `pnpm test`",
    "- first\n- second",
    "> quoted text",
    "[Cake](https://example.com)",
    "https://example.com",
    "```ts\nconst answer = 42;\n```",
    "| Name | Score |\n| --- | ---: |\n| Cake | 10 |",
    "Before  \nafter",
  ])("detects formatting in %j", (source) => {
    expect(shouldRenderMarkdown(source)).toBe(true);
  });

  it.each([
    "An ordinary sentence.",
    "First line\nSecond line",
    "Issue #1 is still open.",
    "The temperature is -5 degrees.",
    "Use *args and **kwargs in Python.",
    "Price: $20",
    "<div>HTML is not rendered by Cake</div>",
  ])("leaves plain text unchanged in %j", (source) => {
    expect(shouldRenderMarkdown(source)).toBe(false);
  });
});
