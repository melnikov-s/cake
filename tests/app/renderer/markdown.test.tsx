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
import { FullscreenSurfaceFixture } from "./fullscreen-surface-fixture";

vi.mock("streamdown", () => ({
  defaultRehypePlugins: {},
  parseMarkdownIntoBlocks: (markdown: string) => [markdown],
  Streamdown: vi.fn(({ children }: { children: string }) => <div>{children}</div>),
  TableCopyDropdown: () => <span>Copy table</span>,
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

  it("uses Cake's table presentation and borderless Mermaid frames with copy and fullscreen actions", () => {
    act(() => root.render(<Markdown>{"| A | B |\n| - | - |\n| 1 | 2 |"}</Markdown>));

    const props = vi.mocked(Streamdown).mock.calls.at(-1)![0];
    expect(props.controls).toEqual({
      code: { copy: true, download: false },
      mermaid: {
        copy: true,
        download: false,
        fullscreen: true,
        panZoom: false,
      },
    });
    expect(props.components?.table).toBeTypeOf("function");
    expect(props.className).toContain("[&_[data-streamdown=mermaid-block]]:border-0");
    expect(props.className).toContain(
      "[&_[data-streamdown=mermaid-block-actions]>button:last-child]:opacity-0",
    );
  });

  it("keeps parsed fullscreen table cells and their actions when streaming settles", () => {
    const onClick = vi.fn();
    vi.mocked(Streamdown).mockImplementation(({ components }) => {
      const Table = components?.table;
      if (!Table || typeof Table !== "function") throw new Error("Expected Cake's table renderer");
      return createElement(Table, {
        children: (
          <tbody>
            <tr>
              <td>
                <strong>Formatted</strong>
                <a href="#source" onClick={onClick}>
                  Source
                </a>
              </td>
            </tr>
          </tbody>
        ),
      });
    });
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <Markdown streaming>table</Markdown>
        </FullscreenSurfaceFixture>,
      ),
    );
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="View table fullscreen"]')!.click(),
    );
    const fullscreen = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(fullscreen?.querySelector("strong")?.textContent).toBe("Formatted");
    act(() => fullscreen?.querySelector<HTMLAnchorElement>("a")?.click());
    expect(onClick).toHaveBeenCalledOnce();
    act(() =>
      root.render(
        <FullscreenSurfaceFixture>
          <Markdown>settled</Markdown>
        </FullscreenSurfaceFixture>,
      ),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBe(fullscreen);
    act(() =>
      fullscreen?.querySelector<HTMLButtonElement>('[aria-label="Exit fullscreen Table"]')?.click(),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keeps a fullscreen Mermaid diagram open when streaming settles", async () => {
    vi.mocked(Streamdown).mockImplementation(({ children }: { children?: string }) => (
      <div>
        {children}
        <div data-streamdown="mermaid-block">
          <div data-streamdown="mermaid-block-actions">
            <button title="Copy Code" type="button">
              <svg aria-label="Copy icon" viewBox="0 0 24 24" />
            </button>
            <button title="View fullscreen" type="button">
              <svg aria-label="Fullscreen icon" viewBox="0 0 24 24" />
            </button>
          </div>
          <div data-streamdown="mermaid">
            <div role="img" aria-label="Mermaid chart">
              <svg aria-label="Rendered diagram" viewBox="0 0 10 10">
                <circle cx="5" cy="5" r="4" />
              </svg>
            </div>
          </div>
        </div>
      </div>
    ));
    const source = "```mermaid\ngraph LR\nA --> B\n```";

    await act(async () => {
      root.render(
        <FullscreenSurfaceFixture>
          <Markdown streaming>{source}</Markdown>
        </FullscreenSurfaceFixture>,
      );
      await import("@streamdown/mermaid");
    });
    act(() =>
      container.querySelector<HTMLButtonElement>('button[title="View fullscreen"]')!.click(),
    );

    const fullscreen = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(fullscreen?.textContent).toContain("Mermaid");
    expect(fullscreen?.querySelector('svg[aria-label="Rendered diagram"]')).not.toBeNull();

    await act(async () => {
      root.render(
        <FullscreenSurfaceFixture>
          <Markdown>{source}</Markdown>
        </FullscreenSurfaceFixture>,
      );
    });
    expect(document.body.querySelector('[role="dialog"]')).toBe(fullscreen);

    act(() =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
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

  it.each([
    ["cake://session/session-123", "/__cake_session__/session-123"],
    ["cake://artifact/report", "/__cake_artifact__/cake%3A%2F%2Fartifact%2Freport"],
    ["src/main.ts#L3", "/__cake_workspace__/src/main.ts#L3"],
  ])("prepares %s links even with an authored title", (href, target) => {
    act(() =>
      root.render(
        <Markdown onOpenSourceLocation={vi.fn()}>{`[Label](${href} "Authored title")`}</Markdown>,
      ),
    );
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(`[Label](${target})`);
  });

  it("routes Markdown heading citations through the safe workspace link target", () => {
    const onOpenSourceLocation = vi.fn();
    const reference = "docs/architecture/s4-artifact-protocol.md#authority-and-durability";
    act(() =>
      root.render(
        <Markdown onOpenSourceLocation={onOpenSourceLocation}>
          {`The [artifact protocol](${reference}) describes artifact updates.`}
        </Markdown>,
      ),
    );
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      `The [artifact protocol](/__cake_workspace__/${reference}) describes artifact updates.`,
    );
    const anchor = vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.a!;
    act(() =>
      root.render(
        createElement(anchor, {
          href: `/__cake_workspace__/${reference}`,
          children: "artifact protocol",
        }),
      ),
    );
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(reference);
    expect(link.getAttribute("aria-description")).toBe(reference);
    act(() => link.click());
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "docs/architecture/s4-artifact-protocol.md",
    });
  });

  it("loads workspace-relative Markdown images through the authorized workspace boundary", async () => {
    const loadWorkspaceImage = vi.fn(async () => ({ data: "cG5n", mimeType: "image/png" }));
    act(() =>
      root.render(
        <MarkdownLinkProvider
          actions={{ openExternalUrl: vi.fn(), openSession: vi.fn(), loadWorkspaceImage }}
        >
          <Markdown onOpenSourceLocation={vi.fn()}>
            ![Visual capture](.visual-captures/example.png)
          </Markdown>
        </MarkdownLinkProvider>,
      ),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "![Visual capture](/__cake_workspace__/.visual-captures/example.png)",
    );
    const imageComponent = vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.img!;
    await act(async () => {
      root.render(
        createElement(imageComponent, {
          src: "/__cake_workspace__/.visual-captures/example.png",
          alt: "Visual capture",
        }),
      );
      await Promise.resolve();
    });

    expect(loadWorkspaceImage).toHaveBeenCalledWith(
      ".visual-captures/example.png",
      expect.any(AbortSignal),
    );
    expect(container.querySelector("img")?.src).toBe("data:image/png;base64,cG5n");
  });

  it("turns a bare artifact URI into an application link", () => {
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
    expect(renderArtifactReference).toHaveBeenCalledWith("cake://artifact/report-1@r2", undefined);
    expect(container.querySelector("[data-testid=artifact-reference]")?.textContent).toBe(
      "cake://artifact/report-1@r2",
    );
  });

  it("preserves the label of an explicit artifact link", () => {
    const renderArtifactReference = vi.fn((reference: string) => (
      <span data-testid="artifact-reference">{reference}</span>
    ));
    act(() =>
      root.render(
        <MarkdownLinkProvider
          actions={{ openExternalUrl: vi.fn(), openSession: vi.fn(), renderArtifactReference }}
        >
          <Markdown>[Narrow layout](cake://artifact/session-assistant-narrow)</Markdown>
        </MarkdownLinkProvider>,
      ),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "[Narrow layout](/__cake_artifact__/cake%3A%2F%2Fartifact%2Fsession-assistant-narrow)",
    );
    const anchorComponent = vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.a!;
    act(() => {
      root.render(
        createElement(anchorComponent, {
          href: "/__cake_artifact__/cake%3A%2F%2Fartifact%2Fsession-assistant-narrow",
          children: "Narrow layout",
        }),
      );
    });
    expect(renderArtifactReference).toHaveBeenCalledWith(
      "cake://artifact/session-assistant-narrow",
      "Narrow layout",
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
        "text-inherit",
        "font-semibold",
        "decoration-solid",
        "decoration-current",
        "underline-offset-4",
      ]),
    );
    expect(fileLink.getAttribute("aria-description")).toBe("src/modelMeta.ts#L8-L12");
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
    expect(beforeLink.getAttribute("aria-description")).toBe(
      "src/modelMeta.ts?view=changes&side=before#L8-L12",
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
    expect(multiRangeLink.getAttribute("aria-description")).toBe(
      "src/modelMeta.ts#L153-L170,L182-L192",
    );
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

    const webLink = renderAnchor({
      href: "https://example.com",
      title: "Custom title",
      children: "example",
    });
    expect(webLink.getAttribute("aria-description")).toBe("https://example.com");
    expect(webLink.className).toContain("text-inherit");
    expect(webLink.target).toBe("_blank");
    act(() => {
      webLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(3);

    const sessionLink = renderAnchor({
      href: "/__cake_session__/session-123",
      title: "Authored title",
      children: "Authentication refactor",
    });
    expect(sessionLink.getAttribute("aria-description")).toBe("cake://session/session-123");
    expect(sessionLink.className).toContain("text-inherit");
    expect(sessionLink.textContent).toBe("Authentication refactor");
    expect(sessionLink.className).toContain("max-w-[80ch]");
    act(() => {
      sessionLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openSession).toHaveBeenCalledWith("session-123");

    act(() => root.render(<Markdown>text</Markdown>));
    const defaultLink = renderAnchor({ href: "docs/readme.md", children: "readme" });
    expect(defaultLink.getAttribute("aria-description")).toBe("docs/readme.md");
    expect(defaultLink.className).toContain("text-inherit");
    expect(defaultLink.target).toBe("_blank");
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(3);
  });
});
