/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { fencedCode, type Markdown } from "../../../src/renderer/components/ai-elements/markdown";
import type { Client } from "../../../src/renderer/client/Client";
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
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("Markdown rendering integration", () => {
  it("renders prose, a highlighted fence and an escaped fence containing backticks", async () => {
    const code = "const sample = `nested`; // ```";
    using fixture = renderMarkdown(
      `# Result\n\nA **formatted** paragraph with \`inline code\`.\n\n${fencedCode(code, "ts")}`,
    );
    expect(screen.getByRole("heading", { name: "Result" })).toBeDefined();
    expect(screen.getByText("formatted").getAttribute("data-streamdown")).toBe("strong");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    await waitFor(() => expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(true));
    expect(codeBodies(fixture.container)[0]!.textContent).toContain(code);
    expect(screen.getByRole("button", { name: "Copy Code" })).toBeDefined();
  });

  it("renders safe content without executing authored HTML or unsafe links", () => {
    using fixture = renderMarkdown(
      [
        "Visible **safe** text.",
        "<script>window.compromised = true</script>",
        '<img src="x" onerror="window.compromised = true">',
        "[Danger](javascript:alert%281%29)",
        "[Data](data:text/html,unsafe)",
        "[Script](vbscript:unsafe)",
        "[Website](https://example.com)",
      ].join("\n\n"),
    );
    expect(screen.getByText("safe").getAttribute("data-streamdown")).toBe("strong");
    expect(fixture.container.querySelector("script, [onerror]")).toBeNull();
    expect(
      fixture.container.querySelector(
        'a[href^="javascript:"], a[href^="data:"], a[href^="vbscript:"]',
      ),
    ).toBeNull();
    expect(screen.getByRole("link", { name: "Website" }).getAttribute("href")).toBe(
      "https://example.com/",
    );
  });

  it.each(["https", "http"])(
    "routes %s website links through the typed desktop boundary",
    async (scheme) => {
      const openExternalUrl = vi.fn<Client["electron"]["openExternalUrl"]>(async () => undefined);
      using fixture = renderMarkdown(`[Example](${scheme}://example.com "Authored title")`, {
        client: { electron: { openExternalUrl } },
      });
      const link = screen.getByRole("link", { name: "Example" });
      expect(link.getAttribute("aria-description")).toBe(`${scheme}://example.com/`);
      expect(link.getAttribute("target")).toBe("_blank");
      await fixture.user.click(link);
      expect(openExternalUrl).toHaveBeenCalledWith(`${scheme}://example.com/`, {
        signal: expect.any(AbortSignal),
      });
    },
  );

  it.each([
    "![Preview](https://example.com/preview.png)",
    "**![Preview](https://example.com/preview.png)**",
  ])("preserves code spans and linked images (%s) while adorning text links", (imageLabel) => {
    using fixture = renderMarkdown(
      [
        "[**Website**](https://example.com/docs)",
        "[`source.ts`](src/source.ts#L2)",
        "[Worker](cake://session/session-123?message=entry-42)",
        "[Report](cake://artifact/report-1@r2)",
        `[${imageLabel}](https://example.com/full.png)`,
        "![Standalone](https://example.com/standalone.png)",
        "`[not a link](https://example.com)`",
      ].join(" · "),
      { props: { onOpenSourceLocation: () => undefined } },
    );
    for (const name of ["Website", "source.ts", "Worker", "Report"]) {
      const link = screen.getByRole("link", { name });
      expect(link.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
      expect(link.getAttribute("tabindex")).toBeNull();
    }
    expect(screen.getByText("source.ts").tagName).toBe("CODE");
    expect(screen.getByText("[not a link](https://example.com)").tagName).toBe("CODE");
    const image = screen.getByRole("img", { name: "Preview" });
    expect(image.getAttribute("src")).toBe("https://example.com/preview.png");
    expect(image.closest("a")?.getAttribute("href")).toBe("https://example.com/full.png");
    expect(image.closest("a")?.querySelector("svg")).toBeNull();
    expect(screen.getByRole("img", { name: "Standalone" }).getAttribute("src")).toBe(
      "https://example.com/standalone.png",
    );
    expect(fixture.container.querySelectorAll("a")).toHaveLength(5);
  });

  it("routes source ranges, changes and heading citations from real parsed anchors", async () => {
    // Source navigation is Markdown's typed public output boundary; no Store is replaced.
    const open = vi.fn<NonNullable<ComponentProps<typeof Markdown>["onOpenSourceLocation"]>>();
    using fixture = renderMarkdown(
      [
        '[file](src/modelMeta.ts#L8-L12 "Authored title")',
        "[before](src/modelMeta.ts?view=changes&side=before#L8-L12)",
        "[functions](src/modelMeta.ts#L153-L170,L182-L192)",
        "[sibling](../sibling/notes.txt#L2-L3)",
        "[absolute](/authorized/notes.txt?view=changes&side=before#L2)",
        "[protocol](docs/architecture/s4-artifact-protocol.md#authority-and-durability)",
        "src/main.ts:880:12 and `src/not-a-link.ts:3`",
      ].join(" · "),
      { props: { onOpenSourceLocation: open } },
    );
    await fixture.user.click(screen.getByRole("link", { name: "file" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "src/modelMeta.ts",
      range: { start: { line: 7 }, end: { line: 11 } },
    });
    await fixture.user.click(screen.getByRole("link", { name: "before" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "src/modelMeta.ts",
      view: "changes",
      side: "before",
      range: { start: { line: 7 }, end: { line: 11 } },
    });
    await fixture.user.click(screen.getByRole("link", { name: "functions" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "src/modelMeta.ts",
      ranges: [
        { start: { line: 152 }, end: { line: 169 } },
        { start: { line: 181 }, end: { line: 191 } },
      ],
    });
    await fixture.user.click(screen.getByRole("link", { name: "protocol" }));
    expect(open).toHaveBeenLastCalledWith({ path: "docs/architecture/s4-artifact-protocol.md" });
    await fixture.user.click(screen.getByRole("link", { name: "src/main.ts:880:12" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "src/main.ts",
      range: { start: { line: 879, column: 11 } },
    });
    await fixture.user.click(screen.getByRole("link", { name: "sibling" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "../sibling/notes.txt",
      range: { start: { line: 1 }, end: { line: 2 } },
    });
    await fixture.user.click(screen.getByRole("link", { name: "absolute" }));
    expect(open).toHaveBeenLastCalledWith({
      path: "/authorized/notes.txt",
      view: "changes",
      side: "before",
      range: { start: { line: 1 }, end: { line: 1 } },
    });
    expect(screen.queryByRole("link", { name: "src/not-a-link.ts:3" })).toBeNull();
    expect(screen.getByText("src/not-a-link.ts:3").tagName).toBe("CODE");
  });

  it("preserves session and artifact targets and authored labels through sanitization", async () => {
    const openSession = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    using fixture = renderMarkdown(
      [
        '[Authentication refactor](cake://session/session-123 "Authored title")',
        '[Narrow layout](cake://artifact/session-assistant-narrow "Authored title")',
        "Review cake://artifact/report-1@r2 before publishing.",
      ].join("\n\n"),
      { sessionLinkTarget: "session-123", client: { projectSessions: { open: openSession } } },
    );
    const session = screen.getByRole("link", { name: "Authentication refactor" });
    expect(session.getAttribute("href")).toBe("cake://session/session-123");
    expect(session.getAttribute("aria-description")).toBe("cake://session/session-123");
    await fixture.user.click(session);
    expect(openSession).toHaveBeenCalledWith(
      { sessionId: "session-123", workingDirectory: "/work/cake" },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByRole("link", { name: "Narrow layout" }).getAttribute("href")).toBe(
      "cake://artifact/session-assistant-narrow",
    );
    expect(
      screen.getByRole("link", { name: "cake://artifact/report-1@r2" }).getAttribute("href"),
    ).toBe("cake://artifact/report-1@r2");
  });

  it.each(["f80c961e", "01957936-0000-7000-8000-0001f80c961e", "`f80c961e`"])(
    "displays the identity label %s without a prefix and navigates with its full Pi UUID",
    async (label) => {
      const sessionId = "01957936-0000-7000-8000-0001f80c961e";
      const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
      using fixture = renderMarkdown(`Session [${label}](cake://session/${sessionId})`, {
        sessionLinkTarget: sessionId,
        client: { projectSessions: { open } },
      });
      const link = screen.getByRole("link", { name: "f80c961e" });
      expect(link.getAttribute("href")).toBe(`cake://session/${sessionId}`);
      expect(link.getAttribute("aria-description")).toBe(`cake://session/${sessionId}`);
      await fixture.user.click(link);
      expect(open).toHaveBeenCalledWith(
        { sessionId, workingDirectory: "/work/cake" },
        { signal: expect.any(AbortSignal) },
      );
    },
  );

  it.each(["f80c961e"])(
    "canonicalizes the existing short target %s without changing reference parsing",
    async (reference) => {
      const sessionId = "01957936-0000-7000-8000-0001f80c961e";
      const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
      using fixture = renderMarkdown(`[${reference}](cake://session/${reference})`, {
        sessionLinkTarget: sessionId,
        client: { projectSessions: { open } },
      });
      const link = screen.getByRole("link", { name: "f80c961e" });
      expect(link.getAttribute("href")).toBe(`cake://session/${sessionId}`);
      await fixture.user.click(link);
      expect(open).toHaveBeenCalledWith(
        { sessionId, workingDirectory: "/work/cake" },
        { signal: expect.any(AbortSignal) },
      );
    },
  );

  it("extends colliding display suffixes while retaining exact message targets and authored titles", async () => {
    const sessionId = "01957936-0000-7000-8000-0001f80c961e";
    const otherId = "01957936-0000-7000-8000-0002f80c961e";
    const openSession = vi.fn();
    using fixture = renderMarkdown(
      `[1f80c961e](cake://session/${sessionId}?message=entry-42) · [Review worker](cake://session/${otherId})`,
      { actions: { sessionIds: () => [sessionId, otherId], openSession } },
    );
    const link = screen.getByRole("link", { name: "1f80c961e" });
    expect(link.getAttribute("href")).toBe(`cake://session/${sessionId}?message=entry-42`);
    await fixture.user.click(link);
    expect(openSession).toHaveBeenCalledWith(sessionId, "entry-42");
    expect(screen.getByRole("link", { name: "Review worker" }).getAttribute("href")).toBe(
      `cake://session/${otherId}`,
    );
  });

  it.each(["f80c961e"])(
    "does not guess a canonical destination for an ambiguous target %s",
    async (reference) => {
      const ids = ["01957936-0000-7000-8000-0001f80c961e", "01957936-0000-7000-8000-0002f80c961e"];
      const openSession = vi.fn();
      using fixture = renderMarkdown(`[Worker](cake://session/${reference})`, {
        actions: { sessionIds: () => ids, openSession },
      });
      const link = screen.getByRole("link", { name: "Worker" });
      expect(link.getAttribute("href")).toBe(`cake://session/${encodeURIComponent(reference)}`);
      await fixture.user.click(link);
      expect(openSession).toHaveBeenCalledWith(reference);
    },
  );

  it("leaves literal reference text and code outside session links unchanged", () => {
    using fixture = renderMarkdown(
      "Reference f80c961e and `f80c961e`. [f80c961e](https://example.com) · [f80c961e **worker**](cake://session/01957936-0000-7000-8000-0001f80c961e)",
    );
    expect(fixture.container.textContent).toContain("Reference f80c961e and f80c961e.");
    expect(screen.getByRole("link", { name: "f80c961e worker" })).toBeDefined();
    expect(screen.getByRole("link", { name: "f80c961e" }).getAttribute("href")).toBe(
      "https://example.com/",
    );
  });

  it.each([
    ["message=entry-42", "entry-42", undefined],
    [
      "attachment=00000000-0000-4000-8000-000000000001",
      undefined,
      "00000000-0000-4000-8000-000000000001",
    ],
  ])(
    "preserves titled session links with %s through parsing and navigation",
    async (query, messageId, attachmentId) => {
      const openSession = vi.fn();
      const target = `cake://session/session-123?${query}`;
      using fixture = renderMarkdown(`[Exact source](${target} "Authored title")`, {
        actions: { openSession },
      });
      const link = screen.getByRole("link", { name: "Exact source" });
      expect(link.getAttribute("href")).toBe(target);
      await fixture.user.click(link);
      if (attachmentId)
        expect(openSession).toHaveBeenCalledWith("session-123", undefined, attachmentId);
      else expect(openSession).toHaveBeenCalledWith("session-123", messageId);
    },
  );

  it("loads workspace images only through the authorized image service", async () => {
    const readImage = vi.fn<Client["filesystem"]["readImage"]>(async () => ({
      data: "cG5n",
      mimeType: "image/png",
    }));
    using fixture = renderMarkdown("![Visual capture](.visual-captures/example.png)", {
      props: { onOpenSourceLocation: () => undefined },
      actions: { loadWorkspaceImage: (path, signal) => readImage("/work/cake", path, { signal }) },
      client: { filesystem: { readImage } },
    });
    expect(
      (await within(fixture.container).findByRole("img", { name: "Visual capture" })).getAttribute(
        "src",
      ),
    ).toBe("data:image/png;base64,cG5n");
    expect(readImage).toHaveBeenCalledWith("/work/cake", ".visual-captures/example.png", {
      signal: expect.any(AbortSignal),
    });
  });

  it("shows image failures and cancels obsolete workspace reads", async () => {
    let signal: AbortSignal | undefined;
    const readImage = vi.fn<Client["filesystem"]["readImage"]>(
      async (_directory, path, options) => {
        if (path === "missing.png") throw new Error("Not authorized");
        signal = options?.signal;
        return new Promise(() => undefined);
      },
    );
    using fixture = renderMarkdown("![Missing](missing.png)", {
      props: { onOpenSourceLocation: () => undefined },
      actions: {
        loadWorkspaceImage: (path, abort) => readImage("/work/cake", path, { signal: abort }),
      },
      client: { filesystem: { readImage } },
    });
    expect(await screen.findByText("Image not available: Missing")).toBeDefined();
    await fixture.update("![Pending](pending.png)");
    expect(await screen.findByText("Loading image…")).toBeDefined();
    await fixture.update("Replacement prose.");
    expect(signal?.aborted).toBe(true);
  });

  it("keeps parsed fullscreen table cells and link actions when streaming settles", async () => {
    const openExternalUrl = vi.fn<Client["electron"]["openExternalUrl"]>(async () => undefined);
    const source = "| Content |\n| --- |\n| **Formatted** [Source](https://example.com/source) |";
    using fixture = renderMarkdown(source, {
      props: { streaming: true },
      client: { electron: { openExternalUrl } },
    });
    await fixture.user.click(screen.getByRole("button", { name: "View table fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Table" });
    expect(within(fullscreen).getByText("Formatted").getAttribute("data-streamdown")).toBe(
      "strong",
    );
    await fixture.user.click(within(fullscreen).getByRole("link", { name: "Source" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/source", {
      signal: expect.any(AbortSignal),
    });
    await fixture.update(source, { streaming: false });
    expect(screen.getByRole("dialog", { name: "Table" })).toBe(fullscreen);
    await fixture.user.click(
      within(fullscreen).getByRole("button", { name: "Exit fullscreen Table" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders LaTeX delimiters as math without changing inline and fenced code", async () => {
    using fixture = renderMarkdown(
      "Inline \\(x + y\\).\n\n\\[\nE = mc^2\n\\]\n\n`\\(inline code\\)`\n\n````tex\n\\[fenced code\\]\n````",
    );
    await waitFor(() => expect(fixture.container.querySelectorAll(".katex")).toHaveLength(1));
    // The installed math plugin disables single-dollar inline math by default.
    expect(screen.getByText("Inline $x + y$.")).toBeDefined();
    expect(fixture.container.querySelector(".katex-display")).not.toBeNull();
    expect(screen.getByText("\\(inline code\\)").tagName).toBe("CODE");
    expect(codeBodies(fixture.container)[0]!.textContent).toContain("\\[fenced code\\]");
    expect(fixture.container.querySelector('[data-streamdown="mermaid"]')).toBeNull();
  });

  it("can defer math normalization for an incomplete streaming response", () => {
    using fixture = renderMarkdown("Streaming \\(x + y\\) and \\[E = mc^2\\]", {
      props: { normalizeLatexDelimiters: false },
    });
    expect(fixture.container.textContent).toContain("Streaming (x + y) and [E = mc^2]");
    expect(fixture.container.querySelector(".katex")).toBeNull();
  });

  it("keeps an actual Mermaid diagram fullscreen when streaming settles", async () => {
    // jsdom has no SVG layout; this supplies only browser measurement, not a
    // diagram renderer. Real Mermaid parsing, sanitization and SVG run here.
    const original = Object.getOwnPropertyDescriptor(SVGElement.prototype, "getBBox");
    const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
    class VisibleIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "0px";
      readonly thresholds = [0];
      constructor(private callback: IntersectionObserverCallback) {}
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
      observe(target: Element) {
        queueMicrotask(() =>
          this.callback(
            [
              {
                target,
                isIntersecting: true,
                intersectionRatio: 1,
                time: 0,
                boundingClientRect: new DOMRect(),
                intersectionRect: new DOMRect(),
                rootBounds: null,
              },
            ],
            this,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: VisibleIntersectionObserver,
    });
    Object.defineProperty(SVGElement.prototype, "getBBox", {
      configurable: true,
      value: () => new DOMRect(0, 0, 100, 30),
    });
    try {
      document.documentElement.dataset.theme = "dark";
      const source = "```mermaid\ngraph LR\nA[Start] --> B[Finish]\n```";
      using fixture = renderMarkdown(source, { props: { streaming: true } });
      await waitFor(
        () =>
          expect(
            fixture.container.querySelector('[data-streamdown="mermaid"] [role="img"] > svg'),
          ).not.toBeNull(),
        { timeout: 5000 },
      );
      expect(
        fixture.container.querySelector('[data-streamdown="mermaid"] svg style')?.textContent,
      ).toContain("fill:#1f2020");
      await fixture.user.click(screen.getByRole("button", { name: "View fullscreen" }));
      const fullscreen = screen.getByRole("dialog", { name: "Mermaid" });
      expect(fullscreen.querySelector("svg")).not.toBeNull();
      expect(fullscreen.textContent).toContain("Start");
      expect(fullscreen.textContent).toContain("Finish");
      await fixture.update(source, { streaming: false });
      expect(screen.getByRole("dialog", { name: "Mermaid" })).toBe(fullscreen);
      await fixture.user.click(
        within(fullscreen).getByRole("button", { name: "Exit fullscreen Mermaid" }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      if (originalObserver)
        Object.defineProperty(globalThis, "IntersectionObserver", originalObserver);
      else Reflect.deleteProperty(globalThis, "IntersectionObserver");
      if (original) Object.defineProperty(SVGElement.prototype, "getBBox", original);
      else Reflect.deleteProperty(SVGElement.prototype, "getBBox");
    }
  });

  it("retains dual-theme highlighted tokens across a live color theme change", async () => {
    document.documentElement.dataset.theme = "light";
    using fixture = renderMarkdown("```ts\nconst themed = true;\n```");
    await waitFor(() => expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(true));
    const code = codeBodies(fixture.container)[0]!;
    expect(code.querySelector('span[style*="--sdm-c"]')).not.toBeNull();
    await act(async () => {
      document.documentElement.dataset.theme = "dark";
    });
    expect(codeBodies(fixture.container)[0]).toBe(code);
    expect(highlighted(code)).toBe(true);
    expect(code.textContent).toContain("const themed = true;");
  });
});
