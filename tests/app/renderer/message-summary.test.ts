import { expect, it } from "vitest";
import { markdownSummary } from "../../../src/renderer/lib/message-summary";

it("previews the opening text of a Markdown message as one plain line", () => {
  expect(
    markdownSummary(
      "## Build fixed\n\nThe flaky `pnpm test` step now **waits** for the [server](https://x.dev) port.",
    ),
  ).toBe("Build fixed The flaky pnpm test step now waits for the server port.");
  expect(markdownSummary("```ts\nconst hidden = true;\n```\n\n1. First *item*")).toBe("First item");
  expect(markdownSummary("keep snake_case and 2 * 3")).toBe("keep snake_case and 2 * 3");
  expect(markdownSummary("\n\n---\n")).toBeUndefined();
});
