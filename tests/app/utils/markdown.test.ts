import { describe, expect, it } from "vitest";
import { markdownTextPreview, shouldRenderMarkdown } from "../../../src/utils/markdown";

describe("markdownTextPreview", () => {
  it("keeps readable source content while deferring images and navigation", () => {
    expect(
      markdownTextPreview(
        "## Result\n\n**Verified** [source](cake://session/producer?message=result).\n\n![Screenshot](private.png)\n\n![Reference][image]\n\n[image]: attachment.png",
      ),
    ).toBe("Result\nVerified source.\n[Image: Screenshot]\n[Image: Reference]");
  });

  it("bounds excerpts and retains honest empty content", () => {
    expect(markdownTextPreview("**" + "a".repeat(500) + "**")).toBe("a".repeat(400));
    expect(markdownTextPreview("   ")).toBe("");
  });
});

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
