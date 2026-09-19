/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Streamdown } from "streamdown";
import {
  fencedCode,
  Markdown,
  MarkdownLinkProvider,
} from "../../../src/renderer/components/ai-elements/markdown";
import { syntaxHighlighter } from "../../../src/renderer/lib/syntax-highlighter";

vi.mock("streamdown", () => ({
  defaultRehypePlugins: {},
  parseMarkdownIntoBlocks: (markdown: string) => [markdown],
  Streamdown: vi.fn(({ children }: { children: string }) => <div>{children}</div>),
}));

describe("Markdown", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(Streamdown).mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
    container.remove();
  });

  it("keeps Streamdown's block parser stable across transcript updates", () => {
    act(() => root.render(<Markdown>First</Markdown>));
    const firstProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    act(() => root.render(<Markdown>Second</Markdown>));
    const secondProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    expect(secondProps).toMatchObject({ isAnimating: false, mode: "streaming", skipHtml: true });
    expect(secondProps.parseMarkdownIntoBlocksFn).toBe(firstProps.parseMarkdownIntoBlocksFn);
    expect(secondProps.parseMarkdownIntoBlocksFn?.("first")).toEqual(["first"]);
    expect(secondProps.parseMarkdownIntoBlocksFn?.("changing content")).toEqual([
      "changing content",
    ]);
  });

  it("uses the borderless hover-action presentation for every fenced code block", () => {
    act(() => root.render(<Markdown>```text\nA very long line\n```</Markdown>));

    const className = vi.mocked(Streamdown).mock.calls.at(-1)![0].className;
    expect(className).toContain("[&_[data-streamdown=code-block]]:border-0");
    expect(className).toContain("[&_[data-streamdown=code-block-header]]:hidden");
    expect(className).toContain("[&_[data-streamdown=code-block-actions]]:!absolute");
    expect(className).toContain("[&_[data-streamdown=code-block-actions]]:opacity-0");
    expect(className).toContain(
      "[&_[data-streamdown=code-block]:hover_[data-streamdown=code-block-actions]]:opacity-100",
    );
    expect(className).toContain("[&_[data-streamdown=code-block-body]]:overflow-x-hidden");
    expect(className).toContain("[&_[data-streamdown=code-block-body]_pre]:whitespace-pre-wrap");
    expect(className).toContain(
      "[&_[data-streamdown=code-block-body]_pre]:[overflow-wrap:anywhere]",
    );
  });

  it("uses borderless table and Mermaid frames with only copy and hover-fullscreen actions", () => {
    act(() => root.render(<Markdown>{"| A | B |\n| - | - |\n| 1 | 2 |"}</Markdown>));

    const props = vi.mocked(Streamdown).mock.calls.at(-1)![0];
    expect(props.controls).toEqual({
      code: { copy: true, download: false },
      table: { copy: true, download: false, fullscreen: true },
      mermaid: {
        copy: true,
        download: false,
        fullscreen: true,
        panZoom: false,
      },
    });
    expect(props.className).toContain("[&_[data-streamdown=table-wrapper]]:border-0");
    expect(props.className).toContain("[&_[data-streamdown=mermaid-block]]:border-0");
    expect(props.className).toContain(
      "[&_[data-streamdown=table-wrapper]>div:first-child>button]:opacity-0",
    );
    expect(props.className).toContain(
      "[&_[data-streamdown=mermaid-block-actions]>button:last-child]:opacity-0",
    );
  });

  it("marks only the incomplete fence for block-local plain rendering", () => {
    const source = ["```ts", "const settled = true;", "```", "", "```ts", "const changing ="].join(
      "\n",
    );
    act(() => root.render(<Markdown streaming>{source}</Markdown>));

    const streamdownProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];
    expect(streamdownProps.children).toBe(
      [
        "```ts",
        "const settled = true;",
        "```",
        "",
        "```ts __cake_streaming_code__",
        "__cake_streaming_code__",
        "const changing =",
      ].join("\n"),
    );
    expect(streamdownProps.plugins?.code).toBe(syntaxHighlighter);
    expect(streamdownProps.plugins?.renderers).toHaveLength(1);
  });

  it("does not inject markers into unsupported, unlabelled, Mermaid, or indented literal code", async () => {
    for (const source of [
      "```text\nhello",
      "```\nhello",
      "```mermaid\ngraph TD",
      "- item\n\n      ```ts\n      const literal = true;",
    ]) {
      await act(async () => {
        root.render(<Markdown streaming>{source}</Markdown>);
        if (source.includes("mermaid")) await import("@streamdown/mermaid");
      });
      expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(source);
    }
  });

  it("normalizes a marked language so custom-renderer routing agrees", () => {
    act(() => root.render(<Markdown streaming>{"```TS\nconst value = 1;"}</Markdown>));

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "```ts __cake_streaming_code__\n__cake_streaming_code__\nconst value = 1;",
    );
  });

  it("keeps the streaming highlighter stable across source updates", () => {
    act(() => root.render(<Markdown streaming>{"```ts\nconst value ="}</Markdown>));
    const firstPlugin = vi.mocked(Streamdown).mock.calls.at(-1)![0].plugins?.code;

    act(() => root.render(<Markdown streaming>{"```ts\nconst value = 1"}</Markdown>));
    const secondPlugin = vi.mocked(Streamdown).mock.calls.at(-1)![0].plugins?.code;

    expect(secondPlugin).toBe(firstPlugin);
  });

  it("uses Mermaid's high-contrast theme in dark mode", async () => {
    document.documentElement.dataset.theme = "light";
    act(() => root.render(<Markdown>```mermaid\ngraph LR\nA --&gt; B\n```</Markdown>));
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].mermaid?.config?.theme).toBe("neutral");

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await import("@streamdown/mermaid");
    });

    const plugins = vi.mocked(Streamdown).mock.calls.at(-1)![0].plugins;
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].mermaid?.config?.theme).toBe("dark");
    expect(plugins?.mermaid).toBeDefined();
    expect(plugins?.math).toBeUndefined();
  });

  it("loads math without loading the Mermaid plugin", async () => {
    await act(async () => {
      root.render(<Markdown>{"$$\nE = mc^2\n$$"}</Markdown>);
      await Promise.all([import("@streamdown/math"), import("katex/dist/katex.min.css")]);
    });

    const plugins = vi.mocked(Streamdown).mock.calls.at(-1)![0].plugins;
    expect(plugins?.math).toBeDefined();
    expect(plugins?.mermaid).toBeUndefined();
  });

  it("creates a safe highlighted fence even when source contains backticks", () => {
    expect(fencedCode("const sample = ```nested```;", "tsx")).toBe(
      "````tsx\nconst sample = ```nested```;\n````",
    );
  });

  it("normalizes LaTeX math delimiters without changing code", async () => {
    const source = [
      "Inline \\(x + y\\).",
      "",
      "\\[",
      "E = mc^2",
      "\\]",
      "",
      "`\\(inline code\\)`",
      "",
      "````tex",
      "\\[fenced code\\]",
      "````",
    ].join("\n");

    await act(async () => {
      root.render(<Markdown>{source}</Markdown>);
      await import("@streamdown/math");
    });

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      [
        "Inline $x + y$.",
        "",
        "$$",
        "E = mc^2",
        "$$",
        "",
        "`\\(inline code\\)`",
        "",
        "````tex",
        "\\[fenced code\\]",
        "````",
      ].join("\n"),
    );
  });

  it("defers LaTeX delimiter normalization while content is streaming", () => {
    const source = "Streaming \\(x + y\\) and \\[E = mc^2\\]";

    act(() => root.render(<Markdown normalizeLatexDelimiters={false}>{source}</Markdown>));

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(source);
  });

  it("recognizes bare source references without changing inline code", () => {
    act(() =>
      root.render(
        <Markdown onOpenSourceLocation={() => undefined}>
          See src/main.ts:880:12, src/main.ts#L153-L170,L182-L192, and `src/not-a-link.ts:3`.
        </Markdown>,
      ),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "See [src/main.ts:880:12](/__cake_workspace__/src/main.ts:880:12), [src/main.ts#L153-L170,L182-L192](/__cake_workspace__/src/main.ts#L153-L170,L182-L192), and `src/not-a-link.ts:3`.",
    );
  });

  it("rewrites session links to a sanitizer-safe internal target", () => {
    act(() =>
      root.render(<Markdown>[Authentication refactor](cake://session/session-123)</Markdown>),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "[Authentication refactor](/__cake_session__/session-123)",
    );
  });

  it("turns a bare artifact URI into a bounded application reference surface", () => {
    const renderArtifactReference = vi.fn((reference: string) => (
      <span data-testid="artifact-reference">{reference}</span>
    ));
    act(() =>
      root.render(
        <MarkdownLinkProvider
          actions={{ openExternalUrl: vi.fn(), openSession: vi.fn(), renderArtifactReference }}
        >
          <Markdown>Review cake://artifact/report-1@r2 before publishing.</Markdown>
        </MarkdownLinkProvider>,
      ),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "Review [cake://artifact/report-1@r2](/__cake_artifact__/cake%3A%2F%2Fartifact%2Freport-1%40r2) before publishing.",
    );
    const anchorComponent = vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.a!;
    act(() => {
      root.render(
        createElement(anchorComponent, {
          href: "/__cake_artifact__/cake%3A%2F%2Fartifact%2Freport-1%40r2",
          children: "cake://artifact/report-1@r2",
        }),
      );
    });
    expect(renderArtifactReference).toHaveBeenCalledWith("cake://artifact/report-1@r2");
    expect(container.querySelector("[data-testid=artifact-reference]")?.textContent).toBe(
      "cake://artifact/report-1@r2",
    );
  });

  it("opens source, website, and session links with their owning application actions", () => {
    const onOpenSourceLocation = vi.fn();
    const openExternalUrl = vi.fn();
    const openSession = vi.fn();
    act(() =>
      root.render(
        <MarkdownLinkProvider actions={{ openExternalUrl, openSession }}>
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>
            {
              "[file](src/modelMeta.ts#L8-L12) · [before](src/modelMeta.ts?view=changes&side=before#L8-L12) · [functions](src/modelMeta.ts#L153-L170,L182-L192)"
            }
          </Markdown>
        </MarkdownLinkProvider>,
      ),
    );
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "[file](/__cake_workspace__/src/modelMeta.ts#L8-L12) · [before](/__cake_workspace__/src/modelMeta.ts?view=changes&side=before#L8-L12) · [functions](/__cake_workspace__/src/modelMeta.ts#L153-L170,L182-L192)",
    );
    const anchorComponent = () => vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.a!;

    const renderAnchor = (props: Record<string, unknown>) => {
      act(() => {
        root.render(createElement(anchorComponent(), props));
      });
      return container.querySelector("a")!;
    };

    const fileLink = renderAnchor({
      href: "/__cake_workspace__/src/modelMeta.ts#L8-L12",
      children: "src/modelMeta.ts#L8-L12",
    });
    expect([...fileLink.classList]).toEqual(
      expect.arrayContaining([
        "underline",
        "decoration-dashed",
        "decoration-border",
        "underline-offset-4",
      ]),
    );
    act(() => {
      fileLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "src/modelMeta.ts",
      range: { start: { line: 7 }, end: { line: 11 } },
    });

    const beforeLink = renderAnchor({
      href: "/__cake_workspace__/src/modelMeta.ts?view=changes&side=before#L8-L12",
      children: "before",
    });
    expect(beforeLink.title).toBe(
      "Open src/modelMeta.ts?view=changes&side=before#L8-L12 in VS Code",
    );
    act(() => {
      beforeLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenSourceLocation).toHaveBeenLastCalledWith({
      path: "src/modelMeta.ts",
      view: "changes",
      side: "before",
      range: { start: { line: 7 }, end: { line: 11 } },
    });

    const multiRangeLink = renderAnchor({
      href: "/__cake_workspace__/src/modelMeta.ts#L153-L170,L182-L192",
      children: "functions",
    });
    expect(multiRangeLink.title).toBe("Open src/modelMeta.ts#L153-L170,L182-L192 in VS Code");
    act(() => {
      multiRangeLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenSourceLocation).toHaveBeenLastCalledWith({
      path: "src/modelMeta.ts",
      ranges: [
        { start: { line: 152 }, end: { line: 169 } },
        { start: { line: 181 }, end: { line: 191 } },
      ],
    });

    const webLink = renderAnchor({ href: "https://example.com", children: "example" });
    expect(webLink.target).toBe("_blank");
    act(() => {
      webLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(3);

    const sessionLink = renderAnchor({
      href: "cake://session/session-123",
      children: "Authentication refactor",
    });
    expect(sessionLink.textContent).toBe("Authentication refactor");
    expect(sessionLink.className).toContain("max-w-[80ch]");
    act(() => {
      sessionLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openSession).toHaveBeenCalledWith("session-123");

    act(() => root.render(<Markdown>text</Markdown>));
    const defaultLink = renderAnchor({ href: "docs/readme.md", children: "readme" });
    expect(defaultLink.target).toBe("_blank");
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(3);
  });
});
