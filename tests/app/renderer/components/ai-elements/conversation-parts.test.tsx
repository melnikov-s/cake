import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Composer, ComposerInput } from "../../../../../src/renderer/components/ai-elements/composer";
import { Markdown } from "../../../../../src/renderer/components/ai-elements/markdown";
import { Reasoning } from "../../../../../src/renderer/components/ai-elements/reasoning";
import { Tool } from "../../../../../src/renderer/components/ai-elements/tool";

describe("Cake-owned conversation components", () => {
  it("renders GFM tables, task lists, safe links, and source-owned code blocks", () => {
    const html = renderToStaticMarkup(<Markdown>{"## Result\n\n**Ready** with `inline` code.\n\n- [x] Markdown\n\n| Feature | State |\n| --- | --- |\n| Tables | Ready |\n\n[Docs](https://example.com)\n\n<script>bad()</script>\n\n```ts\nconst cake = true\n```"}</Markdown>);
    expect(html).toContain("<h2>Result</h2>");
    expect(html).toContain("<strong>Ready</strong>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
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
