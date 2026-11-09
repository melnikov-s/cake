/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { observable } from "r-state-tree";
import {
  fencedCode,
  isStandaloneDiagram,
  Markdown,
  MarkdownLinkProvider,
} from "../../../src/renderer/components/ai-elements/markdown";
import { Tool } from "../../../src/renderer/components/ai-elements/tool";
import { godotDiagram } from "../../fixtures/godot-diagram";
import { installDiagramMeasurement } from "./diagram-browser-fixture";
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
let diagramMeasurement: ReturnType<typeof installDiagramMeasurement>;
beforeEach(() => {
  diagramMeasurement = installDiagramMeasurement();
});
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
  vi.restoreAllMocks();
});

describe("Markdown rendering integration", () => {
  it.each([
    ["```mermaid\ngraph TD\nA --> B\n```", true],
    ["\n  ~~~mermaid title\n  graph TD\n  A --> B\n  ~~~\n", true],
    ["````mermaid\ngraph TD\nA --> B\n````", true],
    ["```mermaid\ngraph TD\nA --> B", true],
    ["A diagram:\n\n```mermaid\ngraph TD\nA --> B\n```", false],
    ["```mermaid\ngraph TD\nA --> B\n```\n\nExplanation.", false],
    ["```ts\nconst language = 'mermaid';\n```", false],
    ["> ```mermaid\n> graph TD\n> A --> B\n> ```", false],
    ["```mermaid\ngraph TD\nA --> B\n```\n\n```mermaid\ngraph TD\nB --> C\n```", false],
  ])("identifies a lone diagram without treating mixed content as one (%s)", (source, expected) => {
    expect(isStandaloneDiagram(source)).toBe(expected);
  });

  it("renders prose, a highlighted fence and an escaped fence containing backticks", async () => {
    const code = "const sample = `nested`; // ```";
    using fixture = renderMarkdown(
      `# Result\n\nA **formatted** paragraph with \`inline code\`.\n\n- [x] Markdown\n\n${fencedCode(code, "ts")}`,
    );
    expect(screen.getByRole("heading", { name: "Result" })).toBeDefined();
    expect(screen.getByText("formatted").getAttribute("data-streamdown")).toBe("strong");
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByRole("checkbox")).toHaveProperty("checked", true);
    expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
    await waitFor(() => expect(highlighted(codeBodies(fixture.container)[0]!)).toBe(true));
    expect(codeBodies(fixture.container)[0]!.textContent).toContain(code);
    expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
  });

  it("gives every fenced snippet, whatever its language, its own copy button beside the code", async () => {
    const snippets = [
      ["bash", 'devx binks check pass shop/world#1 --reason "clear" --apply'],
      ["text", "plain output\nsecond line"],
      ["", "unlabelled fence"],
      ["toml", 'name = "cake"'],
    ] as const;
    using fixture = renderMarkdown(
      snippets.map(([language, code]) => fencedCode(code, language)).join("\n\nBetween.\n\n"),
    );
    const frames = Array.from(
      fixture.container.querySelectorAll<HTMLElement>('[data-slot="code-snippet"]'),
    );
    expect(frames).toHaveLength(snippets.length);
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    for (const [index, frame] of frames.entries()) {
      const button = within(frame).getByRole("button", { name: "Copy code" });
      // The button sits in the frame's gutter, outside the scrolling code body.
      expect(within(frame).getAllByRole("button")).toHaveLength(1);
      expect(codeBodies(frame)[0]!.contains(button)).toBe(false);
      await fixture.user.click(button);
      // Exactly the snippet: no line numbers and no trailing newline.
      expect(copy).toHaveBeenLastCalledWith(snippets[index]![1]);
      expect(within(frame).getByRole("button", { name: "Copied code" })).toBeDefined();
    }
  });

  it("copies a work-log bash command and its output separately", async () => {
    const user = userEvent.setup();
    render(
      <Tool
        part={{
          id: "tool-bash",
          kind: "tool",
          name: "bash",
          input: "git status --short",
          outputContent: [{ type: "text", text: " M src/app.ts\n" }],
          state: "success",
        }}
        expansion={{ open: true, toggle: () => undefined }}
      />,
    );
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const [command, output] = screen.getAllByRole("button", { name: "Copy code" });
    await user.click(command!);
    expect(copy).toHaveBeenLastCalledWith("git status --short");
    await user.click(output!);
    expect(copy).toHaveBeenLastCalledWith(" M src/app.ts");
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

  it("does not turn Cake tool names into files and leaves sentence punctuation outside document links", async () => {
    const open = vi.fn();
    using fixture = renderMarkdown(
      "Read workgroups.md and sessions.md. Read it with boards.read before working. Use sessions.reports.read, messages.read, context.compact, boards.search and artifacts.present. Open src/main.ts:8. [Actual file](./boards.read).",
      { props: { onOpenSourceLocation: open } },
    );
    for (const label of [
      "boards.read",
      "sessions.reports.read",
      "messages.read",
      "context.compact",
      "boards.search",
      "artifacts.present",
    ])
      expect(screen.queryByRole("link", { name: label })).toBeNull();
    await fixture.user.click(screen.getByRole("link", { name: "workgroups.md" }));
    expect(open).toHaveBeenLastCalledWith({ path: "workgroups.md" });
    await fixture.user.click(screen.getByRole("link", { name: "sessions.md" }));
    expect(open).toHaveBeenLastCalledWith({ path: "sessions.md" });
    await fixture.user.click(screen.getByRole("link", { name: "src/main.ts:8" }));
    expect(open).toHaveBeenLastCalledWith({ path: "src/main.ts", range: { start: { line: 7 } } });
    await fixture.user.click(screen.getByRole("link", { name: "Actual file" }));
    expect(open).toHaveBeenLastCalledWith({ path: "./boards.read" });
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
    expect(session.getAttribute("aria-description")).toBe(
      "Authentication refactor\ncake://session/session-123",
    );
    await fixture.user.click(session);
    await waitFor(() =>
      expect(openSession).toHaveBeenCalledWith(
        { sessionId: "session-123", workingDirectory: "/work/cake" },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(screen.getByRole("link", { name: "Narrow layout" }).getAttribute("href")).toBe(
      "cake://artifact/session-assistant-narrow",
    );
    expect(
      screen.getByRole("link", { name: "cake://artifact/report-1@r2" }).getAttribute("href"),
    ).toBe("cake://artifact/report-1@r2");
  });

  it("renders generic session labels as compact named inline pills and follows passive title updates", async () => {
    const id = "97029b94-7529-41e7-989e-e5bc1f4dd622";
    const title = "Strengthen workflow-friction recognition instructions";
    const titles = observable(new Map([[id, title]]));
    const openSession = vi.fn();
    using fixture = renderMarkdown(`[Session](cake://session/${id})can this be resolved now?`, {
      actions: { sessionTitle: (id) => titles.get(id), openSession },
    });
    const link = screen.getByRole("link", { name: title });
    expect(link.dataset.slot).toBe("session-reference");
    expect(link.className).toContain("inline-flex");
    expect(link.className).toContain("bg-accent/10");
    expect(link.className).toContain("no-underline");
    expect(link.querySelector("span")?.className).toContain("truncate");
    expect(link.closest("p")?.textContent).toBe(`${title}can this be resolved now?`);
    expect(link.nextSibling?.textContent).toBe("can this be resolved now?");
    await fixture.user.click(link);
    expect(openSession).toHaveBeenCalledWith(id);
    act(() => titles.set(id, "Updated session title"));
    await waitFor(() => expect(link.textContent).toBe("Updated session title"));
    expect(link.getAttribute("aria-description")).toBe(
      `Updated session title\ncake://session/${id}`,
    );
    act(() => titles.delete(id));
    await waitFor(() => expect(link.textContent).toBe("Session"));
  });

  it.each([undefined, "", "   "])("falls back safely when the known title is %s", (title) => {
    using fixture = renderMarkdown(
      "Before [Session](cake://session/unavailable?message=entry-42) after",
      {
        actions: { sessionTitle: () => title },
      },
    );
    const link = screen.getByRole("link", { name: "Session" });
    expect(link.getAttribute("href")).toBe("cake://session/unavailable?message=entry-42");
    expect(link.closest("p")?.textContent).toBe("Before Session after");
  });

  it("preserves authored report labels and exact encoded message and attachment targets when titles are known", async () => {
    const openSession = vi.fn();
    const id = "session with spaces";
    const target = "cake://session/session%20with%20spaces?message=entry%2F42";
    using fixture = renderMarkdown(
      `[Full **agent response**](${target}) · [Capture notes](cake://session/session%20with%20spaces?attachment=00000000-0000-4000-8000-000000000001)`,
      { actions: { sessionTitle: () => "Actual title", openSession } },
    );
    const report = screen.getByRole("link", { name: "Full agent response" });
    expect(report.getAttribute("href")).toBe(target);
    expect(report.getAttribute("aria-description")).toBe(
      `Full agent response\nActual title\n${target}`,
    );
    await fixture.user.click(report);
    expect(openSession).toHaveBeenLastCalledWith(id, "entry/42");
    await fixture.user.click(screen.getByRole("link", { name: "Capture notes" }));
    expect(openSession).toHaveBeenLastCalledWith(
      id,
      undefined,
      "00000000-0000-4000-8000-000000000001",
    );
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
      expect(link.getAttribute("aria-description")).toBe(`f80c961e\ncake://session/${sessionId}`);
      await fixture.user.click(link);
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          { sessionId, workingDirectory: "/work/cake" },
          { signal: expect.any(AbortSignal) },
        ),
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
      await waitFor(() =>
        expect(open).toHaveBeenCalledWith(
          { sessionId, workingDirectory: "/work/cake" },
          { signal: expect.any(AbortSignal) },
        ),
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

  it("routes titled exact-message and attachment links through real session navigation", async () => {
    const sessionId = "session-123";
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const inspect = vi.fn<Client["sessionChats"]["inspect"]>();
    const readAttachment = vi.fn<Client["sessionChats"]["readAttachment"]>(async () => ({
      kind: "text",
      reference: {
        kind: "input",
        id: attachmentId,
        name: "Original input",
        mimeType: "text/plain",
        byteLength: 25,
      },
      text: "Exact attachment evidence",
      offset: 0,
      totalCharacters: 25,
      nextOffset: null,
    }));
    const open = vi.fn<Client["projectSessions"]["open"]>(async () => undefined);
    const messageTarget = `cake://session/${sessionId}?message=entry-42`;
    const attachmentTarget = `cake://session/${sessionId}?attachment=${attachmentId}`;
    using fixture = renderMarkdown(
      `[Exact message](${messageTarget} "Authored title") · [Exact attachment](${attachmentTarget} "Authored title")`,
      {
        sessionLinkTarget: sessionId,
        sessionLinkParts: [
          {
            id: "answer",
            entryId: "entry-42",
            kind: "text",
            role: "assistant",
            text: "Exact answer",
            status: "complete",
          },
        ],
        client: { projectSessions: { open }, sessionChats: { inspect, readAttachment } },
      },
    );
    const messageLink = screen.getByRole("link", { name: "Exact message" });
    expect(messageLink.getAttribute("href")).toBe(messageTarget);
    await fixture.user.click(messageLink);
    await waitFor(() =>
      expect(
        fixture.root.sessionRegistry.findSession(sessionId)?.conversationSessionStore.chatStore
          .transcriptInteraction.selectedMessageId,
      ).toBe("answer"),
    );
    expect(inspect).not.toHaveBeenCalled();
    const attachmentLink = screen.getByRole("link", { name: "Exact attachment" });
    expect(attachmentLink.getAttribute("href")).toBe(attachmentTarget);
    await fixture.user.click(attachmentLink);
    await waitFor(() =>
      expect(readAttachment).toHaveBeenCalledExactlyOnceWith(
        { sessionId, reference: attachmentId, offset: 0, limit: 20_000 },
        { signal: expect.any(AbortSignal) },
      ),
    );
    expect(open).toHaveBeenCalledWith(
      { sessionId, workingDirectory: "/work/cake" },
      { signal: expect.any(AbortSignal) },
    );
  });

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
    const placeholder = (await screen.findByText("Image not available: Missing")).closest(
      '[role="note"]',
    );
    expect(placeholder?.textContent).toContain("missing.png");
    expect(placeholder?.textContent).toContain("Not authorized");
    await fixture.update("![Pending](pending.png)");
    expect(await screen.findByText("Loading image…")).toBeDefined();
    await fixture.update("Replacement prose.");
    expect(signal?.aborted).toBe(true);
  });

  it("resolves local images from any path without requiring an editor action, but never rewrites other schemes", async () => {
    const loadWorkspaceImage = vi.fn<
      (path: string, signal: AbortSignal) => Promise<{ data: string; mimeType: string }>
    >(async () => ({ data: "AQID", mimeType: "image/png" }));
    using fixture = renderMarkdown(
      [
        "![Screenshot](.visual-captures/report.png)",
        "![Temporary](/tmp/cake-screens/shot.png)",
        "![Home](~/Desktop/shot.png)",
        "![Local file](file:///private/image.png)",
        "![Remote file](file://server/share/image.png)",
        "![Script](javascript:alert)",
        "![Unknown](custom:private.png)",
      ].join("\n\n"),
      { actions: { loadWorkspaceImage } },
    );
    for (const name of ["Screenshot", "Temporary", "Home", "Local file"])
      expect((await fixture.findByRole("img", { name })).getAttribute("src")).toBe(
        "data:image/png;base64,AQID",
      );
    expect(loadWorkspaceImage.mock.calls.map(([path]) => path)).toEqual([
      ".visual-captures/report.png",
      "/tmp/cake-screens/shot.png",
      "~/Desktop/shot.png",
      "/private/image.png",
    ]);
    expect(screen.queryByRole("img", { name: "Remote file" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Script" })).toBeNull();
    expect(screen.queryByRole("img", { name: "Unknown" })).toBeNull();
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
  });

  it("memoizes preprocessing across unrelated renders but refreshes source and capability changes", async () => {
    const matches = vi.spyOn(RegExp.prototype, Symbol.match);
    const splits = vi.spyOn(RegExp.prototype, Symbol.split);
    const normalizations = () =>
      matches.mock.contexts.filter(
        (regex) => regex instanceof RegExp && regex.source === /[^\n]*\n|[^\n]+$/g.source,
      ).length;
    const linkPreparations = () =>
      splits.mock.contexts.filter(
        (regex) =>
          regex instanceof RegExp &&
          regex.source ===
            /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]+\))/g.source,
      ).length;
    let source = "Read src/example.ts:4. Inline \\(x + y\\).";
    const actions = { openExternalUrl: vi.fn() };
    using fixture = renderMarkdown(source, {
      actions,
      props: { onOpenSourceLocation: () => undefined },
    });
    await waitFor(() => expect(fixture.container.textContent).toContain("$x + y$"));
    const before = [normalizations(), linkPreparations()];
    expect(before[0]).toBeGreaterThan(0);
    expect(before[1]).toBeGreaterThan(0);
    for (let index = 0; index < 3; index++)
      await fixture.update(source, {
        className: `unrelated-${index}`,
        onOpenSourceLocation: () => undefined,
      });
    expect([normalizations(), linkPreparations()]).toEqual(before);
    expect(screen.getByRole("link", { name: "src/example.ts:4" })).toBeDefined();

    source += " Next token.";
    await fixture.update(source, { streaming: true, onOpenSourceLocation: () => undefined });
    expect([normalizations(), linkPreparations()]).toEqual([before[0]! + 1, before[1]! + 1]);
    expect(fixture.container.textContent).toContain("Next token.");
    // A new callback with the same presence is irrelevant to preprocessing, but
    // removing source navigation changes whether bare source links are generated.
    await fixture.update(source, { streaming: true });
    expect([normalizations(), linkPreparations()]).toEqual([before[0]! + 1, before[1]! + 2]);
    expect(screen.queryByRole("link", { name: "src/example.ts:4" })).toBeNull();
    await fixture.update(source, { normalizeLatexDelimiters: false });
    expect(normalizations()).toBe(before[0]! + 1);
    expect(linkPreparations()).toBe(before[1]! + 3);
    expect(fixture.container.textContent).toContain("Inline (x + y).");
    await fixture.update(source, { normalizeLatexDelimiters: true });
    expect([normalizations(), linkPreparations()]).toEqual([before[0]! + 2, before[1]! + 4]);
    expect(fixture.container.textContent).toContain("$x + y$");
  });

  it("keys link preprocessing to image capability rather than provider or loader identity", async () => {
    const splits = vi.spyOn(RegExp.prototype, Symbol.split);
    const preparations = () =>
      splits.mock.calls.filter(([source]) => source === "Plain prose.").length;
    const content = (
      loadWorkspaceImage?: NonNullable<
        ComponentProps<typeof MarkdownLinkProvider>["actions"]["loadWorkspaceImage"]
      >,
    ) => (
      <MarkdownLinkProvider
        actions={{
          openSession: () => undefined,
          openExternalUrl: () => undefined,
          loadWorkspaceImage,
        }}
      >
        <Markdown>Plain prose.</Markdown>
      </MarkdownLinkProvider>
    );
    const view = render(content());
    const initial = preparations();
    expect(initial).toBe(1);
    await act(async () => view.rerender(content()));
    expect(preparations()).toBe(initial);
    const loader = async () => ({ data: "", mimeType: "image/png" });
    await act(async () => view.rerender(content(loader)));
    expect(preparations()).toBe(initial + 1);
    await act(async () =>
      view.rerender(content(async () => ({ data: "changed", mimeType: "image/png" }))),
    );
    expect(preparations()).toBe(initial + 1);
    await act(async () => view.rerender(content()));
    expect(preparations()).toBe(initial + 2);
    expect(view.container.textContent).toBe("Plain prose.");
  });

  it("can defer math normalization for an incomplete streaming response", () => {
    using fixture = renderMarkdown("Streaming \\(x + y\\) and \\[E = mc^2\\]", {
      props: { normalizeLatexDelimiters: false },
    });
    expect(fixture.container.textContent).toContain("Streaming (x + y) and [E = mc^2]");
    expect(fixture.container.querySelector(".katex")).toBeNull();
  });

  it("keeps a Pele diagram fullscreen when streaming settles and routes diagram links", async () => {
    const openExternalUrl = vi.fn<Client["electron"]["openExternalUrl"]>(async () => undefined);
    const source =
      '```mermaid\ngraph LR\nA[Start] --> B[Finish]\nclick A "https://example.com/docs"\n```';
    using fixture = renderMarkdown(source, {
      props: { streaming: true },
      client: { electron: { openExternalUrl } },
    });
    await waitFor(() => expect(fixture.container.querySelector("svg.pele")).not.toBeNull());
    await fixture.user.click(fixture.container.querySelector("svg a")!);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs", {
      signal: expect.any(AbortSignal),
    });
    await fixture.user.click(screen.getByRole("button", { name: "View diagram fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Diagram" });
    await waitFor(() => expect(fullscreen.querySelector("svg.pele")).not.toBeNull());
    expect(fullscreen.textContent).toContain("Start");
    expect(fullscreen.textContent).toContain("Finish");
    await fixture.update(source, { streaming: false });
    expect(screen.getByRole("dialog", { name: "Diagram" })).toBe(fullscreen);
    await fixture.user.click(
      within(fullscreen).getByRole("button", { name: "Exit fullscreen Diagram" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("routes SVG session, artifact and workspace links through Cake actions", async () => {
    const openSession = vi.fn();
    const openArtifact = vi.fn();
    const onOpenSourceLocation = vi.fn();
    using fixture = renderMarkdown(
      [
        "```mermaid",
        "flowchart LR",
        "A[Session] --> B[Artifact] --> C[Source]",
        'click A "cake://session/session-123?message=entry-42"',
        'click B "cake://artifact/report-1@r2"',
        'click C "src/model.ts#L3"',
        "```",
      ].join("\n"),
      { actions: { openSession, openArtifact }, props: { onOpenSourceLocation } },
    );
    await waitFor(() => expect(fixture.container.querySelectorAll("svg.pele a")).toHaveLength(3));
    const links = fixture.container.querySelectorAll("svg.pele a");
    await fixture.user.click(links[0]!);
    expect(openSession).toHaveBeenCalledWith("session-123", "entry-42", undefined);
    await fixture.user.click(links[1]!);
    expect(openArtifact).toHaveBeenCalledWith("cake://artifact/report-1@r2");
    await fixture.user.click(links[2]!);
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "src/model.ts",
      range: { start: { line: 2 }, end: { line: 2 } },
    });
  });

  it("waits for incomplete and synthetically closed mutable diagrams, then renders corrected content", async () => {
    using fixture = renderMarkdown("```mermaid\nflowchart LR\nA[Draft", {
      props: { streaming: true },
    });
    expect(await screen.findByText("Waiting for diagram…")).toBeDefined();
    expect(screen.queryByText("Diagram could not render")).toBeNull();
    await fixture.update("```mermaid\nflowchart LR\nA[Draft] --> B\n```", {
      streaming: true,
      mutableCode: true,
    });
    expect(screen.getByText("Waiting for diagram…")).toBeDefined();
    await fixture.update("```mermaid\nflowchart LR\nA[Done] --> B\n```", {
      streaming: false,
    });
    await waitFor(() =>
      expect(fixture.container.querySelector("svg.pele")?.textContent).toContain("Done"),
    );
  });

  it.each(["", "\n```"])(
    "renders unchanged diagram content when streaming settles (%s)",
    async (closing) => {
      const source = "```mermaid\n" + godotDiagram + closing;
      using fixture = renderMarkdown(source, { props: { streaming: true, mutableCode: true } });
      expect(await screen.findByText("Waiting for diagram…")).toBeDefined();
      await fixture.update(source, { streaming: false });
      await waitFor(() => expect(fixture.container.querySelector("svg.pele")).not.toBeNull());
    },
  );

  it("adapts Pele layout to resizing and survives a virtualized row remount", async () => {
    const source =
      "```mermaid\nflowchart LR\nA[Start] --> B[Review] --> C[Build] --> D[Test] --> E[Finish]\n```";
    using fixture = renderMarkdown(source);
    await waitFor(() => expect(fixture.container.querySelector("svg.pele")).not.toBeNull());
    const wideViewBox = fixture.container.querySelector("svg.pele")!.getAttribute("viewBox");
    await act(async () => diagramMeasurement.resize(320));
    await waitFor(() =>
      expect(fixture.container.querySelector("svg.pele")?.getAttribute("viewBox")).not.toBe(
        wideViewBox,
      ),
    );
    await fixture.update("Offscreen row placeholder.");
    await fixture.update(source);
    await waitFor(() =>
      expect(fixture.container.querySelector("svg.pele")?.textContent).toContain("Finish"),
    );
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
