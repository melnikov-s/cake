/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fencedCode, Markdown } from "../../../src/renderer/components/ai-elements/markdown";
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

  function mockSynchronousHighlighting() {
    return vi.spyOn(syntaxHighlighter, "highlight").mockImplementation((options) => ({
      tokens: options.code.split("\n").map((content) => [
        {
          content,
          htmlAttrs: { "data-syntax-highlighted": "true" },
        },
      ]),
    }));
  }

  function codeBodies() {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-streamdown="code-block-body"]'),
    );
  }

  it("keeps distinct settled fences highlighted while an identical fence grows", async () => {
    const highlight = mockSynchronousHighlighting();
    const settled = [
      "```ts",
      "const repeated = true;",
      "```",
      "",
      "```ts",
      "const second = 2;",
      "```",
      "",
    ].join("\n");

    await render(`${settled}\`\`\`ts\nconst repeated = true;`);

    expect(codeBodies()).toHaveLength(3);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[2]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    const firstSettledBody = codeBodies()[0];
    const secondSettledBody = codeBodies()[1];
    expect(highlight).toHaveBeenCalledTimes(2);

    await render(`${settled}\`\`\`ts\nconst repeated = true;\nconst growing = 1;`);

    expect(codeBodies()[0]).toBe(firstSettledBody);
    expect(codeBodies()[1]).toBe(secondSettledBody);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[2]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    expect(highlight).toHaveBeenCalledTimes(2);

    const closed = `${settled}\`\`\`ts\nconst repeated = true;\nconst growing = 1;\n\`\`\`\nMore prose.`;
    await render(closed);

    expect(codeBodies()[0]).toBe(firstSettledBody);
    expect(codeBodies()[1]).toBe(secondSettledBody);
    expect(codeBodies()[2]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(highlight).toHaveBeenCalledTimes(3);

    await render(`${closed}\n\n\`\`\`ts\nconst next =`);
    expect(codeBodies()).toHaveLength(4);
    expect(codeBodies()[0]).toBe(firstSettledBody);
    expect(codeBodies()[1]).toBe(secondSettledBody);
    expect(codeBodies()[3]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    expect(highlight).toHaveBeenCalledTimes(3);

    await render(`${closed}\n\n\`\`\`ts\nconst next = 3;`, false);
    expect(codeBodies()[0]).toBe(firstSettledBody);
    expect(codeBodies()[1]).toBe(secondSettledBody);
    expect(codeBodies()[3]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(highlight).toHaveBeenCalledTimes(4);
  });

  it("isolates growing fences nested in blockquotes and deeper lists", async () => {
    const highlight = mockSynchronousHighlighting();
    const sources = [
      {
        active: "> ```ts\n> const quoted = true;",
        closed: "> ```ts\n> const quoted = true;\n> ```",
      },
      {
        active: "1. Example\n\n    ```ts\n    const nested = true;",
        closed: "1. Example\n\n    ```ts\n    const nested = true;\n    ```",
      },
      {
        active: "- ```ts\n  const direct = true;",
        closed: "- ```ts\n  const direct = true;\n  ```",
      },
    ];

    for (const source of sources) {
      await render(source.active);
      expect(codeBodies()).toHaveLength(1);
      expect(codeBodies()[0]!.textContent).toContain("true;");
      expect(codeBodies()[0]!.textContent).not.toContain("__cake_streaming_code__");
      expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).toBeNull();

      await render(source.closed);
      expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    }
    expect(highlight).toHaveBeenCalledTimes(3);
  });

  it("uses the actual final code node after a container boundary", async () => {
    mockSynchronousHighlighting();
    const source = [
      "> ```ts",
      "> const old = 1;",
      "",
      "Outside.",
      "",
      "```ts",
      "const active = 2;",
    ].join("\n");

    await render(source);

    expect(codeBodies()).toHaveLength(2);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
    expect(codeBodies()[1]!.querySelector("[data-syntax-highlighted]")).toBeNull();
    expect(codeBodies()[1]!.textContent).toContain("const active = 2;");
  });

  it("settles a fence when its blockquote container ends", async () => {
    mockSynchronousHighlighting();

    await render("> ```ts\n> const quoted = true;\n\nOutside.");

    expect(codeBodies()).toHaveLength(1);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
  });

  it("routes uppercase active languages without leaking markers", async () => {
    mockSynchronousHighlighting();

    await render("```TS\nconst upper = true;");
    expect(codeBodies()).toHaveLength(1);
    expect(codeBodies()[0]!.textContent).toContain("const upper = true;");
    expect(codeBodies()[0]!.textContent).not.toContain("__cake_streaming_code__");
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).toBeNull();

    await render("```TS\nconst upper = true;\n```");
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
  });

  it("preserves fence-shaped indented literal code byte-for-byte", async () => {
    mockSynchronousHighlighting();
    const source = "- item\n\n      ```ts\n      const literal = true;";

    await render(source);

    expect(container.textContent).toContain("```ts");
    expect(container.textContent).toContain("const literal = true;");
    expect(container.textContent).not.toContain("__cake_streaming_code__");
  });

  it("keeps noLineNumbers source on separate visual lines while it grows", async () => {
    mockSynchronousHighlighting();

    await render("```ts noLineNumbers\nconst first = 1;\nconst second = 2;");

    const lines = codeBodies()[0]!.querySelectorAll("code > span");
    expect(lines).toHaveLength(2);
    expect(Array.from(lines, (line) => line.classList.contains("block"))).toEqual([true, true]);
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).toBeNull();
  });

  it("keeps a synthetically closed mutable tool fence plain until it settles", async () => {
    const highlight = mockSynchronousHighlighting();
    const initial = fencedCode('{"path":', "json");

    await act(async () => {
      root.render(
        <Markdown streaming mutableCode>
          {initial}
        </Markdown>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).toBeNull();

    await render(initial, false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(container.querySelector("[data-incomplete]")).toBeNull();
    expect(highlight).toHaveBeenCalledOnce();
    expect(codeBodies()[0]!.querySelector("[data-syntax-highlighted]")).not.toBeNull();
  });
});
