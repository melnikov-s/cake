/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Streamdown } from "streamdown";
import { Markdown } from "../../../src/renderer/components/ai-elements/markdown";

vi.mock("streamdown", () => ({
  Streamdown: vi.fn(({ children }: { children: string }) => <div>{children}</div>)
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

  it("keeps Streamdown's unused static block parser stable across transcript updates", () => {
    act(() => root.render(<Markdown>First</Markdown>));
    const firstProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    act(() => root.render(<Markdown>Second</Markdown>));
    const secondProps = vi.mocked(Streamdown).mock.calls.at(-1)![0];

    expect(secondProps).toMatchObject({ isAnimating: false, mode: "static", skipHtml: true });
    expect(secondProps.parseMarkdownIntoBlocksFn).toBe(firstProps.parseMarkdownIntoBlocksFn);
    const firstBlocks = secondProps.parseMarkdownIntoBlocksFn?.("first");
    const secondBlocks = secondProps.parseMarkdownIntoBlocksFn?.("changing content");
    expect(secondBlocks).toBe(firstBlocks);
    expect(secondBlocks).toEqual([]);
  });
});
