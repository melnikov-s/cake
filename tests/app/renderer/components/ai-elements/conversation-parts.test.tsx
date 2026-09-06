import { renderToStaticMarkup } from "react-dom/server";
import { createStore, mount } from "r-state-tree";
import { describe, expect, it } from "vitest";
import {
  Composer,
  ComposerInput,
} from "../../../../../src/renderer/components/ai-elements/composer";
import { Markdown } from "../../../../../src/renderer/components/ai-elements/markdown";
import { Reasoning } from "../../../../../src/renderer/components/ai-elements/reasoning";
import { ShellCommand } from "../../../../../src/renderer/components/ai-elements/shell-command";
import { Tool } from "../../../../../src/renderer/components/ai-elements/tool";
import { WorkLogDiff } from "../../../../../src/renderer/components/ai-elements/work-log-diff";
import { Session } from "../../../../../src/renderer/models/Session";
import { SubagentActivityStore } from "../../../../../src/renderer/stores/SubagentActivityStore";

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
    expect(html).toContain("animate-pulse");
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
    expect(completed).toContain("bg-success");
    expect(active).toContain("bg-accent animate-pulse");
  });

  it("shows work-log paths relative to the project root and keeps outside paths absolute", () => {
    const workspacePath = "/Users/user/dev/cake";
    const inside = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-inside",
          kind: "tool",
          name: "read",
          input: JSON.stringify({ path: `${workspacePath}/src/app.ts` }),
          filePath: `${workspacePath}/src/app.ts`,
          state: "success",
        }}
        workspacePath={workspacePath}
      />,
    );
    const outside = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-outside",
          kind: "tool",
          name: "read",
          input: JSON.stringify({ path: "/etc/hosts" }),
          filePath: "/etc/hosts",
          state: "success",
        }}
        workspacePath={workspacePath}
      />,
    );

    expect(inside).toContain('title="read src/app.ts"');
    expect(inside).not.toContain(workspacePath);
    expect(outside).toContain('title="read /etc/hosts"');
  });

  it("shows aggregate work-log diff paths relative to the project root", () => {
    const workspacePath = "/Users/user/dev/cake";
    const html = renderToStaticMarkup(
      <WorkLogDiff
        parts={[
          {
            id: "tool-edit",
            kind: "tool",
            name: "edit",
            input: "",
            filePath: `${workspacePath}/src/app.ts`,
            diff: "+const value = true;",
            state: "success",
          },
        ]}
        streaming={false}
        workspacePath={workspacePath}
      />,
    );

    expect(html).toContain("src/app.ts");
    expect(html).not.toContain(workspacePath);
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
        expansion={{ open: true, toggle: () => undefined }}
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
    expect(running).not.toContain('class="tool-details"');
    expect(failed).not.toContain('class="tool-details"');
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
    expect(running).toContain("bg-accent animate-pulse");
    expect(success).toContain("bg-success");
    expect(error).toContain("bg-destructive");
    expect(running).not.toContain("<small>running</small>");
    expect(success).not.toContain("<small>success</small>");
    expect(error).not.toContain("<small>error</small>");
  });

  it("does not repeat a Cake topic or operation in its tool title", () => {
    const topic = renderToStaticMarkup(
      <Tool
        part={{
          id: "cake-requests",
          kind: "tool",
          name: "cake",
          command: "requests",
          input: JSON.stringify({ command: "requests", input: { request: {} } }),
          state: "success",
        }}
      />,
    );
    const operation = renderToStaticMarkup(
      <Tool
        part={{
          id: "cake-requests-open",
          kind: "tool",
          name: "cake",
          command: "interview.open",
          input: JSON.stringify({ command: "interview.open", input: { request: {} } }),
          state: "success",
        }}
      />,
    );
    expect(topic).toContain('title="requests"');
    expect(topic).not.toContain('title="requests requests"');
    expect(operation).toContain('title="interview.open"');
    expect(operation).not.toContain('title="interview.open interview.open"');
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
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );
    expect(html).toContain('title="bash for file in *.ts; do echo &quot;$file&quot; done"');
    expect(html).toContain("for file in *.ts; do");
    expect(html).toContain("language-bash");
    expect(html).not.toContain("&quot;command&quot;");
  });

  it("renders user shell commands in their own terminal-style surface", () => {
    const html = renderToStaticMarkup(
      <ShellCommand
        part={{
          id: "command-1",
          kind: "command",
          command: "printf hello",
          output: "hello",
          excludeFromContext: false,
          state: "success",
        }}
      />,
    );
    expect(html).toContain('data-slot="shell-command"');
    expect(html).toContain('title="! printf hello"');
    expect(html).toContain("! printf hello");
    expect(html).toContain("hello");
    expect(html).not.toContain("Work log");

    const hidden = renderToStaticMarkup(
      <ShellCommand
        part={{
          id: "command-2",
          kind: "command",
          command: "printf hidden",
          output: "hidden",
          excludeFromContext: true,
          state: "success",
        }}
      />,
    );
    expect(hidden).toContain("!! printf hidden");
    expect(hidden).toContain("no context");
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
        expansion={{ open: true, toggle: () => undefined }}
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
        expansion={{ open: true, toggle: () => undefined }}
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
        expansion={{ open: true, toggle: () => undefined }}
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
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );
    expect(image).toContain('src="data:image/png;base64,AA=="');
    expect(image).toContain("Tool output image 1");
  });

  it("keeps completed subagent details in a compact released row", () => {
    const handleId = crypto.randomUUID();
    const html = renderToStaticMarkup(
      <Tool
        subagentStartPart={{
          id: "subagent-spawn",
          kind: "tool",
          name: "cake",
          command: "subagents.start",
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
          name: "cake",
          command: "subagents.wait",
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
    expect(html).toContain("Last activity: read");
    expect(html).toContain("Released");
    expect(html).not.toContain("Focus on runtime validation.");
    expect(html).not.toContain("The boundary is correctly isolated.");
  });

  it("renders first-class live activity without a subagent wait call", () => {
    const handleId = crypto.randomUUID();
    const model = Session.create({
      sessionId: "parent",
      subagentActivities: [
        {
          parentSessionId: "parent",
          anchorPartId: "tool-live-spawn",
          handleId,
          revision: 1,
          task: "Inspect the live boundary",
          profile: "reviewer",
          status: "running",
          resolvedModel: {
            requested: "current",
            source: "current",
            provider: "openai-codex",
            modelId: "gpt-5.6-sol",
            thinkingLevel: "medium",
            fallbacks: [],
          },
          fastMode: false,
          retained: false,
          streaming: true,
          parts: [
            {
              id: "child-read",
              kind: "tool",
              name: "read",
              input: "src/main.ts",
              state: "running",
            },
          ],
        },
      ],
    });
    const subagents = mount(
      createStore(SubagentActivityStore, { sessionId: "parent", model, parts: () => [] }),
    );

    const html = renderToStaticMarkup(
      <Tool
        subagents={subagents}
        part={{
          id: "tool-live-spawn",
          kind: "tool",
          name: "cake",
          command: "subagents.start",
          input: JSON.stringify({ task: "Inspect the live boundary", profile: "reviewer" }),
          output: JSON.stringify({ handleId, status: "running" }),
          state: "success",
        }}
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );

    expect(html).toContain("Inspect the live boundary");
    expect(html).toContain("openai-codex/gpt-5.6-sol");
    expect(html).toContain("Running read");
    expect(html).toContain("running");
    subagents[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("renders every recorded child from a historical parallel delegation", () => {
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "tool-parallel",
          kind: "tool",
          name: "cake",
          command: "subagents.parallel",
          input: JSON.stringify({
            tasks: [
              { task: "Inspect storage", profile: "scout" },
              { task: "Review rendering", profile: "reviewer" },
            ],
          }),
          output: JSON.stringify({
            completed: 2,
            total: 2,
            results: [
              {
                handleId: crypto.randomUUID(),
                task: "Inspect storage",
                profile: "scout",
                status: "complete",
                parts: [{ id: "storage-result", kind: "text", text: "Storage is sound." }],
              },
              {
                handleId: crypto.randomUUID(),
                task: "Review rendering",
                profile: "reviewer",
                status: "complete",
                parts: [{ id: "render-result", kind: "text", text: "Rendering is sound." }],
              },
            ],
          }),
          state: "success",
        }}
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );

    expect(html).toContain("Delegated work");
    expect(html).toContain("2/2 complete");
    expect(html).toContain("Inspect storage");
    expect(html).toContain("Review rendering");
    expect(html).toContain("Released");
    expect(html).not.toContain("Storage is sound.");
    expect(html).not.toContain("Rendering is sound.");
  });

  it("moves completed subagent output out of the inline work log", () => {
    const handleId = crypto.randomUUID();
    const html = renderToStaticMarkup(
      <Tool
        part={{
          id: "subagent-wait",
          kind: "tool",
          name: "cake",
          command: "subagents.wait",
          input: JSON.stringify({ handleId }),
          output: JSON.stringify({
            handleId,
            task: "Tell a joke",
            profile: "worker",
            status: "complete",
            parts: [
              {
                id: "child-answer",
                kind: "text",
                role: "assistant",
                text: "The delegated punchline.",
                status: "complete",
              },
            ],
          }),
          state: "success",
        }}
        expansion={{ open: false, toggle: () => undefined }}
      />,
    );

    expect(html).toContain("Tell a joke");
    expect(html).toContain("Released");
    expect(html).not.toContain("The delegated punchline.");
  });
});
