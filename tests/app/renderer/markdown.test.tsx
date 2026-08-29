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
    delete document.documentElement.dataset.theme;
    container.remove();
  });

  it("keeps Streamdown's static block parser stable across transcript updates", () => {
    act(() => root.render(<Markdown>First</Markdown>));
    const firstProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    act(() => root.render(<Markdown>Second</Markdown>));
    const secondProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    expect(secondProps).toMatchObject({ isAnimating: false, mode: "static", skipHtml: true });
    expect(secondProps.parseMarkdownIntoBlocksFn).toBe(firstProps.parseMarkdownIntoBlocksFn);
    expect(secondProps.parseMarkdownIntoBlocksFn?.("first")).toEqual(["first"]);
    expect(secondProps.parseMarkdownIntoBlocksFn?.("changing content")).toEqual([
      "changing content",
    ]);
  });

  it("wraps fenced code instead of horizontally scrolling", () => {
    act(() => root.render(<Markdown>```md\nA very long line\n```</Markdown>));

    const className = vi.mocked(Streamdown).mock.calls.at(-1)![0].className;
    expect(className).toContain("[&_[data-streamdown=code-block-body]]:overflow-x-hidden");
    expect(className).toContain("[&_[data-streamdown=code-block-body]_pre]:whitespace-pre-wrap");
    expect(className).toContain(
      "[&_[data-streamdown=code-block-body]_pre]:[overflow-wrap:anywhere]",
    );
  });

  it("omits the code plugin while changing content should not be highlighted", () => {
    act(() => root.render(<Markdown highlightCode={false}>```ts\nconst value = 1\n```</Markdown>));

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].plugins?.code).toBeUndefined();
  });

  it("uses Mermaid's high-contrast theme in dark mode", async () => {
    document.documentElement.dataset.theme = "light";
    act(() => root.render(<Markdown>```mermaid\ngraph LR\nA --&gt; B\n```</Markdown>));
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].mermaid?.config?.theme).toBe("neutral");

    await act(async () => {
      document.documentElement.dataset.theme = "dark";
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].mermaid?.config?.theme).toBe("dark");
  });

  it("creates a safe highlighted fence even when source contains backticks", () => {
    expect(fencedCode("const sample = ```nested```;", "tsx")).toBe(
      "````tsx\nconst sample = ```nested```;\n````",
    );
  });

  it("recognizes bare source references without changing inline code", () => {
    act(() =>
      root.render(
        <Markdown onOpenSourceLocation={() => undefined}>
          See src/main.ts:880:12 and `src/not-a-link.ts:3`.
        </Markdown>,
      ),
    );

    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "See [src/main.ts:880:12](/__cake_workspace__/src/main.ts:880:12) and `src/not-a-link.ts:3`.",
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

  it("opens source, website, and session links with their owning application actions", () => {
    const onOpenSourceLocation = vi.fn();
    const openExternalUrl = vi.fn();
    const openSession = vi.fn();
    act(() =>
      root.render(
        <MarkdownLinkProvider actions={{ openExternalUrl, openSession }}>
          <Markdown onOpenSourceLocation={onOpenSourceLocation}>
            [file](src/modelMeta.ts#L8-L12)
          </Markdown>
        </MarkdownLinkProvider>,
      ),
    );
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "[file](/__cake_workspace__/src/modelMeta.ts#L8-L12)",
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
    act(() => {
      fileLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "src/modelMeta.ts",
      range: { start: { line: 7 }, end: { line: 11 } },
    });

    const webLink = renderAnchor({ href: "https://example.com", children: "example" });
    expect(webLink.target).toBe("_blank");
    act(() => {
      webLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(1);

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
    expect(onOpenSourceLocation).toHaveBeenCalledTimes(1);
  });
});
