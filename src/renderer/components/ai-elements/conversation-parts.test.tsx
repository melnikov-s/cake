import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, ComposerInput } from "./composer";
import { Markdown } from "./markdown";
import { Reasoning } from "./reasoning";
import { Tool } from "./tool";

describe("Cake-owned conversation components", () => {
  it("renders Markdown as inert text and source-owned code blocks", () => {
    const html = renderToStaticMarkup(<Markdown>{"Hello <script>bad()</script>\n```ts\nconst cake = true\n```"}</Markdown>);
    expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(html).toContain("<pre");
  });

  it("renders Cake reasoning, tool, and composer props without AI SDK types", () => {
    const html = renderToStaticMarkup(<><Reasoning open onToggle={() => undefined}>trace</Reasoning><Tool part={{ id: "tool-1", kind: "tool", name: "read", input: "file", output: "contents", state: "success" }} /><Composer><ComposerInput defaultValue="prompt" /></Composer></>);
    expect(html).toContain("Reasoning");
    expect(html).toContain("read · success");
    expect(html).toContain("prompt");
  });
});
