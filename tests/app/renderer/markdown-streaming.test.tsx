/** @vitest-environment jsdom */
import { cleanup, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fencedCode } from "../../../src/renderer/components/ai-elements/markdown";
import {
  codeBodies,
  highlighted,
  installMarkdownWorker,
  renderMarkdown,
} from "./markdown-rendering-fixture";

let worker: Awaited<ReturnType<typeof installMarkdownWorker>>;
beforeAll(async () => {
  worker = await installMarkdownWorker();
});
afterAll(() => worker[Symbol.dispose]());
afterEach(cleanup);

describe("streaming Markdown with real highlighting", () => {
  it("keeps settled fences highlighted while an identical fence grows and settles", async () => {
    const settled = "```ts\nconst repeated = true;\n```\n\n```ts\nconst second = 2;\n```\n\n";
    using fixture = renderMarkdown(`${settled}\`\`\`ts\nconst repeated = true;`, {
      props: { streaming: true },
    });
    const bodies = () => codeBodies(fixture.container);
    await waitFor(() => expect(bodies().map(highlighted)).toEqual([true, true, false]));
    const first = bodies()[0];
    const second = bodies()[1];
    await fixture.update(`${settled}\`\`\`ts\nconst repeated = true;\nconst growing = 1;`);
    expect(bodies()[0]).toBe(first);
    expect(bodies()[1]).toBe(second);
    expect(bodies().map(highlighted)).toEqual([true, true, false]);
    expect(bodies()[2]!.textContent).toContain("const growing = 1;");

    const closed = `${settled}\`\`\`ts\nconst repeated = true;\nconst growing = 1;\n\`\`\`\nMore prose.`;
    await fixture.update(closed);
    await waitFor(() => expect(bodies().map(highlighted)).toEqual([true, true, true]));
    await fixture.update(`${closed}\n\n\`\`\`ts\nconst next =`);
    expect(bodies().map(highlighted)).toEqual([true, true, true, false]);
    expect(bodies()[0]).toBe(first);
    expect(bodies()[1]).toBe(second);
    await fixture.update(`${closed}\n\n\`\`\`ts\nconst next = 3;`, { streaming: false });
    await waitFor(() => expect(bodies().map(highlighted)).toEqual([true, true, true, true]));
    expect(bodies()[0]).toBe(first);
    expect(fixture.container.textContent).not.toContain("__cake_streaming_code__");
  });

  it.each([
    ["> ```ts\n> const quoted = true;", "> ```ts\n> const quoted = true;\n> ```"],
    [
      "1. Example\n\n    ```ts\n    const nested = true;",
      "1. Example\n\n    ```ts\n    const nested = true;\n    ```",
    ],
    ["- ```ts\n  const direct = true;", "- ```ts\n  const direct = true;\n  ```"],
    ["```TS\nconst upper = true;", "```TS\nconst upper = true;\n```"],
  ])("isolates the active fence in %s", async (active, closed) => {
    using fixture = renderMarkdown(active, { props: { streaming: true } });
    const body = () => codeBodies(fixture.container)[0]!;
    expect(codeBodies(fixture.container)).toHaveLength(1);
    expect(body().textContent).toContain("true;");
    expect(body().textContent).not.toContain("__cake_streaming_code__");
    expect(highlighted(body())).toBe(false);
    await fixture.update(closed);
    await waitFor(() => expect(highlighted(body())).toBe(true));
  });

  it("settles the old container's code while keeping the actual final fence plain", async () => {
    using fixture = renderMarkdown(
      "> ```ts\n> const old = 1;\n\nOutside.\n\n```ts\nconst active = 2;",
      { props: { streaming: true } },
    );
    await waitFor(() =>
      expect(codeBodies(fixture.container).map(highlighted)).toEqual([true, false]),
    );
    expect(codeBodies(fixture.container)[1]!.textContent).toContain("const active = 2;");
    expect(fixture.container.textContent).toContain("Outside.");
  });

  it("settles a fence when its blockquote container ends without a closing fence", async () => {
    using fixture = renderMarkdown("> ```ts\n> const ended = true;\n\nOutside.", {
      props: { streaming: true },
    });
    await waitFor(() => expect(codeBodies(fixture.container).map(highlighted)).toEqual([true]));
    expect(fixture.container.textContent).toContain("Outside.");
  });

  it("preserves fence-shaped indented literal code without leaking streaming markers", () => {
    using fixture = renderMarkdown("- item\n\n      ```ts\n      const literal = true;", {
      props: { streaming: true },
    });
    expect(fixture.container.textContent).toContain("```ts");
    expect(fixture.container.textContent).toContain("const literal = true;");
    expect(fixture.container.textContent).not.toContain("__cake_streaming_code__");
  });

  it.each(["text", "", "made-up-language"])(
    "preserves unsupported or unlabeled %s code during streaming",
    (language) => {
      using fixture = renderMarkdown(`\`\`\`${language}\nplain source`, {
        props: { streaming: true },
      });
      expect(fixture.container.textContent).toContain("plain source");
      expect(fixture.container.textContent).not.toContain("__cake_streaming_code__");
    },
  );

  it("keeps noLineNumbers source on separate lines while it grows", () => {
    using fixture = renderMarkdown("```ts noLineNumbers\nconst first = 1;\nconst second = 2;", {
      props: { streaming: true },
    });
    const lines = codeBodies(fixture.container)[0]!.querySelectorAll("code > span");
    expect(Array.from(lines, (line) => line.textContent)).toEqual([
      "const first = 1;",
      "const second = 2;",
    ]);
    expect(Array.from(lines, (line) => line.classList.contains("block"))).toEqual([true, true]);
    expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(false);
  });

  it("keeps a synthetically closed mutable tool fence plain until it settles", async () => {
    const initial = fencedCode('{"path":', "json");
    using fixture = renderMarkdown(initial, { props: { streaming: true, mutableCode: true } });
    expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(false);
    expect(codeBodies(fixture.container)[0]!.textContent).toContain('{"path":');
    await fixture.update(initial, { streaming: false });
    await waitFor(() => expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(true));
    expect(fixture.container.querySelector("[data-incomplete]")).toBeNull();
  });
});
