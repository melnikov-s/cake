/**
 * @vitest-environment jsdom
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Streamdown } from "streamdown";
import { fencedCode, Markdown } from "../../../src/renderer/components/ai-elements/markdown";

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

  it("creates a safe highlighted fence even when source contains backticks", () => {
    expect(fencedCode("const sample = ```nested```;", "tsx")).toBe(
      "````tsx\nconst sample = ```nested```;\n````",
    );
  });

  it("opens path-like links through onOpenFilePath and leaves web links external", () => {
    const onOpenFilePath = vi.fn();
    act(() =>
      root.render(<Markdown onOpenFilePath={onOpenFilePath}>[file](src/modelMeta.ts)</Markdown>),
    );
    expect(vi.mocked(Streamdown).mock.calls.at(-1)![0].children).toBe(
      "[file](/__cake_workspace__/src/modelMeta.ts)",
    );
    const anchorComponent = () => vi.mocked(Streamdown).mock.calls.at(-1)![0].components!.a!;

    const renderAnchor = (props: Record<string, unknown>) => {
      act(() => {
        root.render(createElement(anchorComponent(), props));
      });
      return container.querySelector("a")!;
    };

    const fileLink = renderAnchor({ href: "src/modelMeta.ts", children: "src/modelMeta.ts" });
    act(() => {
      fileLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(onOpenFilePath).toHaveBeenCalledWith("src/modelMeta.ts");

    const webLink = renderAnchor({ href: "https://example.com", children: "example" });
    expect(webLink.target).toBe("_blank");
    expect(onOpenFilePath).toHaveBeenCalledTimes(1);

    act(() => root.render(<Markdown>text</Markdown>));
    const defaultLink = renderAnchor({ href: "docs/readme.md", children: "readme" });
    expect(defaultLink.target).toBe("_blank");
    expect(onOpenFilePath).toHaveBeenCalledTimes(1);
  });
});
