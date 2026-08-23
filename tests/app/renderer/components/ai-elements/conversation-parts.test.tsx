import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Composer,
  ComposerInput,
} from "../../../../../src/renderer/components/ai-elements/composer";
import { Markdown } from "../../../../../src/renderer/components/ai-elements/markdown";
import { Reasoning } from "../../../../../src/renderer/components/ai-elements/reasoning";
import { Tool } from "../../../../../src/renderer/components/ai-elements/tool";

describe("Cake-owned conversation components", () => {
  it("renders GFM tables, task lists, safe links, and code blocks", () => {
    const html = renderToStaticMarkup(
      <Markdown>
        {
          "## Result\n\n**Ready** with `inline` code.\n\n- [x] Markdown\n\n| Feature | State |\n| --- | --- |\n| Tables | Ready |\n\n[Docs](https://example.com)\n\n<script>bad()</script>\n\n```ts\nconst cake = true\n```"
        }
      </Markdown>,
    );
    expect(html).toContain('data-streamdown="heading-2">Result</h2>');
    expect(html).toContain('data-streamdown="strong">Ready</span>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<table");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).not.toContain("bad()");
    expect(html).toContain("<pre");
  });

  it("renders math and recognizes Mermaid diagrams through the shared Markdown path", () => {
    const html = renderToStaticMarkup(
      <Markdown>{"$$\\nE = mc^2\\n$$\\n\\n```mermaid\\ngraph LR\\n  A --> B\\n```"}</Markdown>,
    );
    expect(html).toContain("katex");
    expect(html).toContain("graph LR");
  });

  it("renders Cake reasoning, tool, and composer props without AI SDK types", () => {
    const html = renderToStaticMarkup(
      <>
        <Reasoning open onToggle={() => undefined}>
          trace
        </Reasoning>
        <Tool
          part={{
            id: "tool-1",
            kind: "tool",
            name: "read",
            input: "file",
            output: "contents",
            state: "success",
          }}
        />
        <Composer>
          <ComposerInput defaultValue="prompt" />
        </Composer>
      </>,
    );
    expect(html).toContain("Reasoning");
    expect(html).toContain("read");
    expect(html).toContain("success");
    expect(html).toContain("prompt");
  });

  it("does not offer an empty reasoning block as expandable content", () => {
    const html = renderToStaticMarkup(
      <Reasoning open={false} onToggle={() => undefined} hasContent={false}>
        {" "}
      </Reasoning>,
    );
    expect(html).toContain("Reasoning details not exposed");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("· show");
  });

  it("does not claim an empty streaming block is unavailable before it finishes", () => {
    const html = renderToStaticMarkup(
      <Reasoning open={false} onToggle={() => undefined} hasContent={false} streaming>
        {" "}
      </Reasoning>,
    );
    expect(html).toContain("Thinking…");
    expect(html).toContain('class="tool-state tool-running" aria-label="running"');
    expect(html).not.toContain("not exposed");
  });

  it("labels completed and active reasoning with the same state indicators as tools", () => {
    const completed = renderToStaticMarkup(
      <Reasoning open={false} onToggle={() => undefined}>
        trace
      </Reasoning>,
    );
    const active = renderToStaticMarkup(
      <Reasoning open={false} onToggle={() => undefined} streaming>
        trace
      </Reasoning>,
    );
    expect(completed).toContain('class="tool-state tool-success" aria-label="success"');
    expect(active).toContain('class="tool-state tool-running" aria-label="running"');
  });

  it("renders edit calls as a readable code diff", () => {
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-edit",
          kind: "tool",
          name: "edit",
          input: JSON.stringify({
            path: "src/app.ts",
            edits: [{ oldText: "const old = true;", newText: "const fresh = true;" }],
          }),
          filePath: "src/app.ts",
          diff: "-4 const old = true;\n+4 const fresh = true;",
          state: "success",
        }}
      />,
    );
    expect(html).toContain("edit src/app.ts");
    expect(html).toContain("Old line 4");
    expect(html).toContain("New line 4");
    expect(html).toContain("const fresh = true;");
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).not.toContain("oldText");
  });

  it("does not automatically expand running or failed tool calls", () => {
    const running = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-running",
          kind: "tool",
          name: "edit",
          input: "",
          diff: "+new line",
          state: "running",
        }}
      />,
    );
    const failed = renderToStaticMarkup(
      <Tool
        part={{ id: "tool-error", kind: "tool", name: "bash", input: "exit 1", state: "error" }}
      />,
    );
    expect(running).toContain('aria-expanded="false"');
    expect(failed).toContain('aria-expanded="false"');
    expect(running).toMatch(/class="tool-details" hidden/);
    expect(failed).toMatch(/class="tool-details" hidden/);
  });

  it("uses state indicators without redundant visible state labels", () => {
    const running = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-running",
          kind: "tool",
          name: "bash",
          input: "sleep 1",
          state: "running",
        }}
      />,
    );
    const success = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-success",
          kind: "tool",
          name: "read",
          input: "README.md",
          state: "success",
        }}
      />,
    );
    const error = renderToStaticMarkup(
      <Tool
        part={{ id: "tool-error", kind: "tool", name: "bash", input: "exit 1", state: "error" }}
      />,
    );
    expect(running).toContain('class="tool-state tool-running" aria-label="running"');
    expect(success).toContain('class="tool-state tool-success" aria-label="success"');
    expect(error).toContain('class="tool-state tool-error" aria-label="error"');
    expect(running).not.toContain("<small>running</small>");
    expect(success).not.toContain("<small>success</small>");
    expect(error).not.toContain("<small>error</small>");
  });

  it("renders bash commands as highlighted shell code instead of JSON", () => {
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-bash",
          kind: "tool",
          name: "bash",
          input: 'for file in *.ts; do\n  echo "$file"\ndone',
          state: "success",
        }}
      />,
    );
    expect(html).toContain('title="bash for file in *.ts; do echo &quot;$file&quot; done"');
    expect(html).toContain("for file in *.ts; do");
    expect(html).toContain("language-bash");
    expect(html).not.toContain("&quot;command&quot;");
  });

  it("renders read results as highlighted file contents instead of JSON arguments", () => {
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-read",
          kind: "tool",
          name: "read",
          input: '{"path":"src/app.ts","offset":12}',
          filePath: "src/app.ts",
          output: "export const value: boolean = true;",
          state: "success",
        }}
      />,
    );
    expect(html).toContain('title="read src/app.ts"');
    expect(html).toContain('data-language="typescript"');
    expect(html).toContain("export const value: boolean = true;");
    expect(html).toContain("before:content-[counter(line)]");
    expect(html).not.toContain("&quot;path&quot;");
  });

  it("infers the source language for read results without a projected file path", () => {
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-read",
          kind: "tool",
          name: "read",
          input: '{"path":"README.md"}',
          output: "# Cake\n\nA desktop app",
          state: "success",
        }}
      />,
    );
    expect(html).toContain('data-language="markdown"');
    expect(html).toContain("# Cake");
    expect(html).not.toContain("&quot;path&quot;");
  });

  it("renders typed bash results without the result envelope", () => {
    const text = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-bash-result",
          kind: "tool",
          name: "bash",
          input: "printf '{\\\"ok\\\":true}'",
          output: '{"content":[{"type":"text","text":"{\\"ok\\":true}"}]}',
          outputContent: [{ type: "text", text: '{"ok":true}' }],
          state: "success",
        }}
      />,
    );
    expect(text).toContain('data-language="text"');
    expect(text).toContain("ok");
    expect(text).not.toContain("&quot;content&quot;");

    const image = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-image-result",
          kind: "tool",
          name: "bash",
          input: "screenshot",
          outputContent: [{ type: "image", data: "AA==", mimeType: "image/png" }],
          state: "success",
        }}
      />,
    );
    expect(image).toContain('src="data:image/png;base64,AA=="');
    expect(image).toContain("Tool output image 1");
  });

  it("renders the subagent request, resolved model, execution trace, and response", () => {
    const handleId = crypto.randomUUID();
    const html = renderToStaticMarkup(
      <Tool
        subagentSpawnPart={{
          id: "subagent-spawn",
          kind: "tool",
          name: "subagent_spawn",
          input: JSON.stringify({
            task: "Inspect the session boundary",
            profile: "reviewer",
            model: {
              prefer: "exact",
              provider: "openai-codex",
              modelId: "gpt-5.6-sol",
              thinkingLevel: "max",
            },
            instructions: "Focus on runtime validation.",
            retain: false,
            maxDepth: 0,
          }),
          output: JSON.stringify({ handleId }),
          state: "success",
        }}
        part={{
          id: "subagent-wait",
          kind: "tool",
          name: "subagent_wait",
          input: JSON.stringify({ handleId }),
          output: JSON.stringify({
            handleId,
            task: "Inspect the session boundary",
            profile: "reviewer",
            status: "complete",
            resolvedModel: {
              requested: "exact",
              source: "exact",
              provider: "openai-codex",
              modelId: "gpt-5.6-sol",
              thinkingLevel: "max",
              fallbacks: [],
            },
            parts: [
              {
                id: "child-tool",
                kind: "tool",
                name: "read",
                input: "src/main.ts",
                state: "success",
              },
              {
                id: "child-text",
                kind: "text",
                role: "assistant",
                text: "The boundary is correctly isolated.",
                status: "complete",
              },
            ],
            usage: {
              tokens: { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, total: 125 },
              cost: 0.002,
            },
          }),
          state: "success",
        }}
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );
    expect(html).toContain("reviewer subagent");
    expect(html).toContain("openai-codex/gpt-5.6-sol");
    expect(html).toContain("Inspect the session boundary");
    expect(html).toContain("Focus on runtime validation.");
    expect(html).toContain("Subagent execution trace");
    expect(html).toContain("125 tokens");
    expect(html).toContain("The boundary is correctly isolated.");
  });
});
