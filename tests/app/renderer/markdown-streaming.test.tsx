/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "../../../src/renderer/components/ai-elements/markdown";
import { syntaxHighlighter } from "../../../src/renderer/lib/syntax-highlighter";

describe("streaming Markdown code", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.restoreAllMocks();
    container.remove();
  });

  async function render(source: string, streaming = true) {
    await act(async () => {
      root.render(<Markdown streaming={streaming}>{source}</Markdown>);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it("keeps settled fences highlighted while only the active fence stays plain", async () => {
    const highlight = vi.spyOn(syntaxHighlighter, "highlight").mockImplementation((options) => ({
      tokens: options.code.split("\n").map((content) => [
        {
          content,
          htmlAttrs: { "data-syntax-highlighted": "true" },
        },
      ]),
    }));
    const prefix = "```ts\nconst settled = true;\n```\n\n```ts\n";

    await render(`${prefix}const changing =`);

    const codeBodies = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"]'));
    expect(codeBodies()).toHaveLength(2);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    const settledBody = codeBodies()[0];

    await render(`${prefix}const changing = 1;`);

    expect(codeBodies()[0]).toBe(settledBody);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    expect(highlight).toHaveBeenCalled();

    await render(`${prefix}const changing = 1;\n` + "```\nDone.");

    expect(codeBodies()[0]).toBe(settledBody);
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
  });
});
