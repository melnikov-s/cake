/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { updateStore } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { renderTranscriptRendering } from "./transcript-rendering-workflow-fixture";
import { godotDiagram } from "../../fixtures/godot-diagram";
import * as messageHighlights from "../../../src/renderer/lib/message-highlights";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";
import { DiagramTestWorker, installDiagramMeasurement } from "./diagram-browser-fixture";

const user: Extract<UiPart, { kind: "text" }> = {
  id: "user",
  entryId: "user-entry",
  kind: "text",
  role: "user",
  text: "# Literal heading\n**Literal emphasis**",
  status: "complete",
};
const answer: Extract<UiPart, { kind: "text" }> = {
  id: "answer",
  entryId: "answer-entry",
  kind: "text",
  role: "assistant",
  text: "Earlier answer",
  status: "complete",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Native scroll opening/following/anchor restoration are owned by
// session-scroll-position.smoke.spec.ts. Selection, annotation highlights and
// fullscreen readers belong to message-selection/side-chat-streaming Electron
// suites. This suite does not fabricate those layout or native-event contracts.
describe("Projected transcript rendering workflows", () => {
  it("does not execute settled message rendering when another message streams", () => {
    // The real assistant renderer calls this hook on every execution. Observe it
    // call-through without replacing the renderer, hooks, or observer memo object;
    // DOM identity alone cannot detect needless renders on every streaming token.
    const renders = vi.spyOn(messageHighlights, "useMessageHighlights");
    const live = {
      ...answer,
      id: "live",
      entryId: "live-entry",
      text: "One",
      status: "streaming" as const,
    };
    using fixture = renderTranscriptRendering([answer, user, live], { streaming: true });
    const count = (text: string) =>
      renders.mock.calls.filter(([, , renderedText]) => renderedText === text).length;
    const settledRenders = count(answer.text);
    expect(settledRenders).toBeGreaterThan(0);
    expect(count(live.text)).toBeGreaterThan(0);
    for (const text of ["One two", "One two three"]) {
      fixture.publish([answer, user, { ...live, text }], true);
      expect(screen.getByText(text)).toBeDefined();
      expect(count(text)).toBeGreaterThan(0);
      expect(count(answer.text)).toBe(settledRenders);
    }
    // Positive control: changing the settled message itself must render it.
    fixture.publish([{ ...answer, text: "Revised answer" }, user, live], true);
    expect(screen.getByText("Revised answer")).toBeDefined();
    expect(count("Revised answer")).toBeGreaterThan(0);
  });

  it("isolates draft changes from surrounding Chat render work", () => {
    // composerVisible is read by Chat's render, not the isolated composer.
    // Observe the real getter without replacing its behavior or any Store.
    const reads = vi.spyOn(ChatStore.prototype, "composerVisible", "get");
    using fixture = renderTranscriptRendering([answer]);
    const surroundingReads = reads.mock.calls.length;
    expect(surroundingReads).toBeGreaterThan(0);
    // This is the reactive invalidation contract, not native typing/focus proof.
    for (const draft of ["Only", "Only update the draft controls"]) {
      act(() => fixture.chat.setDraft(draft));
      expect(screen.getByRole("combobox", { name: "Message" })).toHaveProperty("value", draft);
      expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
      expect(reads).toHaveBeenCalledTimes(surroundingReads);
    }
    // Positive control: a Chat-owned visibility change must reach the observed render.
    act(() => updateStore(fixture.chat, { ...fixture.chat.props, composerVisible: () => false }));
    expect(reads.mock.calls.length).toBeGreaterThan(surroundingReads);
    expect(screen.queryByRole("combobox", { name: "Message" })).toBeNull();
  });

  it("keeps persisted user, review, skill and source content in order and lets the reader inspect a loaded skill", async () => {
    using fixture = renderTranscriptRendering([
      user,
      {
        id: "review",
        kind: "review-run",
        operationId: "00000000-0000-4000-8000-000000000001",
        threadIds: ["review-thread"],
        commentCount: 1,
        status: "complete",
      },
      {
        id: "skill",
        kind: "skill",
        name: "pdf-tools",
        content: "# PDF tools\n\nExtract text from PDFs.",
      },
      { id: "source-one", kind: "source", title: "Reference one", url: "https://example.com/one" },
      { id: "source-two", kind: "source", title: "Reference two", url: "https://example.com/two" },
      answer,
    ]);
    const message = screen.getByText("# Literal heading **Literal emphasis**");
    expect(message.textContent).toBe(user.text);
    expect(within(message).queryByRole("heading")).toBeNull();
    const items = fixture.container.querySelectorAll('[data-slot="transcript-item"]');
    expect(Array.from(items, (item) => item.textContent)).toEqual([
      expect.stringContaining(user.text),
      expect.stringContaining("1 comment replied"),
      expect.stringContaining("Skill loadedpdf-tools"),
      expect.stringContaining("Reference oneReference two"),
      expect.stringContaining(answer.text),
    ]);
    expect(screen.getByRole("link", { name: "Reference one" }).getAttribute("href")).toBe(
      "https://example.com/one",
    );
    expect(screen.getByRole("link", { name: "Reference two" }).getAttribute("href")).toBe(
      "https://example.com/two",
    );
    const skill = screen.getByLabelText("Skill loaded: pdf-tools");
    expect(skill.closest("details")?.open).toBe(false);
    await fixture.user.click(skill);
    expect(skill.closest("details")?.open).toBe(true);
    expect(screen.getByRole("heading", { name: "PDF tools" })).toBeDefined();
    expect(screen.getByText("Extract text from PDFs.")).toBeDefined();
  });

  it("renders persisted image and browser attachments and an annotation-only user turn without an empty text bubble", () => {
    using fixture = renderTranscriptRendering([
      answer,
      { ...user, text: "", id: "annotation-only" },
      {
        id: "annotation",
        kind: "annotation",
        annotations: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            messageId: "answer",
            entryId: "answer-entry",
            selectedText: "Earlier answer",
            startOffset: 0,
            endOffset: 14,
            contextBefore: "",
            contextAfter: "",
          },
        ],
      },
      {
        id: "browser",
        kind: "attachment",
        name: "button#save",
        mediaType: "text/html",
        attachmentKind: "browser",
        url: "https://example.com/settings",
        tagName: "button",
        selector: "button#save",
        outerHTML: '<button id="save">Save</button>',
        browserText: "Save",
      },
      {
        id: "image",
        kind: "attachment",
        name: "Image 1",
        mediaType: "image/png",
        attachmentKind: "image",
        data: "aW1hZ2U=",
      },
    ]);
    expect(screen.getByRole("button", { name: "View 1 annotation" })).toBeDefined();
    expect(
      Array.from(
        fixture.container.querySelectorAll('[data-slot="message-content"]'),
        (message) => message.textContent,
      ),
    ).toEqual([answer.text]);
    expect(screen.getByText("button#save")).toBeDefined();
    expect(screen.getByRole("img", { name: "Image 1" }).getAttribute("src")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
  });

  it("keeps one working indicator through reasoning, tools, the between-parts gap and assistant tokens, then settles the turn", () => {
    using fixture = renderTranscriptRendering([], { streaming: true });
    const loading = () => fixture.container.querySelector('[data-slot="loading-state"]');
    expect(loading()).not.toBeNull();
    fixture.publish([answer, user], true);
    const indicator = loading();
    const settledMessage = screen.getByText("Earlier answer");
    const reasoning: UiPart = {
      id: "reasoning",
      kind: "reasoning",
      text: "",
      status: "streaming",
    };
    fixture.publish([answer, user, reasoning], true);
    expect(screen.getByText("Thinking…")).toBeDefined();
    expect(loading()).toBe(indicator);
    const settledReasoning = { ...reasoning, status: "complete" as const };
    fixture.publish([answer, user, settledReasoning], true);
    const undisclosedReasoning = screen.getByText("Reasoning details not exposed");
    expect(undisclosedReasoning.closest("details")).toBeNull();
    expect(loading()).toBe(indicator);
    const tool: UiPart = {
      id: "tool",
      kind: "tool",
      name: "read",
      input: JSON.stringify({ path: "README.md" }),
      state: "running",
    };
    fixture.publish([answer, user, settledReasoning, tool], true);
    expect(loading()).toBe(indicator);
    fixture.publish([answer, user, settledReasoning, { ...tool, state: "success" }], true);
    expect(loading()).toBe(indicator);
    const live: Extract<UiPart, { kind: "text" }> = {
      id: "live-answer",
      kind: "text",
      role: "assistant",
      text: "Writing",
      status: "streaming",
    };
    for (const text of ["Writing", "Writing the answer"]) {
      fixture.publish(
        [answer, user, settledReasoning, { ...tool, state: "success" }, { ...live, text }],
        true,
      );
      expect(loading()).toBe(indicator);
      expect(screen.getByText(text)).toBeDefined();
      expect(screen.getByText("Earlier answer")).toBe(settledMessage);
    }
    fixture.publish([
      answer,
      user,
      settledReasoning,
      { ...tool, state: "success" },
      { ...live, text: "The completed answer", status: "complete" },
    ]);
    expect(loading()).toBeNull();
    expect(screen.getByText("The completed answer")).toBeDefined();
    expect(screen.getByText("Earlier answer")).toBe(settledMessage);
  });

  it("shows a user shell command independently of assistant work and lets the reader collapse its output", async () => {
    using fixture = renderTranscriptRendering([
      {
        id: "command",
        kind: "command",
        command: "printf hello",
        output: "hello",
        excludeFromContext: false,
        state: "success",
      },
    ]);
    const trigger = screen.getByRole("button", { name: /printf hello/ });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(fixture.container.querySelector('[data-slot="activity-group"]')).toBeNull();
    expect(fixture.container.querySelector('[data-slot="loading-state"]')).toBeNull();
    await fixture.user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await fixture.user.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("hello")).toBeDefined();
  });

  it("renders the reported diagram when an unchanged, unclosed live fence settles to history", async () => {
    installDiagramMeasurement();
    vi.stubGlobal("Worker", DiagramTestWorker);
    const live: Extract<UiPart, { kind: "text" }> = {
      ...answer,
      id: "live-diagram",
      entryId: undefined,
      renderKey: "diagram-response",
      text: `\`\`\`mermaid\n${godotDiagram}`,
      status: "streaming",
    };
    using fixture = renderTranscriptRendering([live], { streaming: true });
    expect(await screen.findByText("Waiting for diagram…")).toBeDefined();
    fixture.publish([{ ...live, id: "saved-diagram", entryId: "saved-entry", status: "complete" }]);
    await waitFor(() =>
      expect(fixture.container.querySelector("svg.pele")?.textContent).toContain(
        "Godot presentation",
      ),
    );
    expect(screen.queryByText("Waiting for diagram…")).toBeNull();
    expect(screen.queryByText("Diagram could not render")).toBeNull();
  });

  it("uses only the diagram toolbar fullscreen for a lone diagram, but retains the response reader for mixed content", async () => {
    installDiagramMeasurement();
    vi.stubGlobal("Worker", DiagramTestWorker);
    const code = `graph TD\n%% ${"Pipeline details. ".repeat(40)}\nA[Start] --> B[Finish]`;
    const text = `\`\`\`mermaid\n${code}\n\`\`\``;
    expect(text.length).toBeGreaterThan(500);
    using fixture = renderTranscriptRendering([{ ...answer, text }], {
      client: { electron: { setFullscreenSurfaceOpen: async () => undefined } },
    });
    await waitFor(() => expect(fixture.container.querySelector("svg.pele")).not.toBeNull());
    expect(screen.getAllByRole("button", { name: /View .*fullscreen/ })).toHaveLength(1);
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    await fixture.user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(copy).toHaveBeenCalledWith(code);
    await fixture.user.click(screen.getByRole("button", { name: "View diagram fullscreen" }));
    const fullscreen = screen.getByRole("dialog", { name: "Diagram" });
    await waitFor(() => expect(fullscreen.querySelector("svg.pele")).not.toBeNull());
    await fixture.user.click(
      within(fullscreen).getByRole("button", { name: "Exit fullscreen Diagram" }),
    );
    fixture.publish([{ ...answer, text: `Here is the pipeline:\n\n${text}` }]);
    expect(screen.getByRole("button", { name: "View response fullscreen" })).toBeDefined();
    fixture.publish([{ ...answer, text }]);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /View .*fullscreen/ })).toHaveLength(1),
    );
  });

  it("retains an open response reader when live content settles to its persisted identity, and copies the completed response", async () => {
    const setOpen = vi.fn<Client["electron"]["setFullscreenSurfaceOpen"]>(async () => undefined);
    const live: Extract<UiPart, { kind: "text" }> = {
      ...answer,
      id: "live-response",
      entryId: undefined,
      renderKey: "assistant-response-text-0",
      text: "A live response. ".repeat(32).slice(0, 500),
      status: "streaming",
    };
    using fixture = renderTranscriptRendering([{ ...answer, text: "S".repeat(499) }, live], {
      streaming: true,
      client: { electron: { setFullscreenSurfaceOpen: setOpen } },
    });
    // Rendered state and native-service payloads only, not portal geometry,
    // OS fullscreen, focus restoration or Escape behavior.
    expect(screen.getAllByRole("button", { name: "View response fullscreen" })).toHaveLength(1);
    await fixture.user.click(screen.getByRole("button", { name: "View response fullscreen" }));
    const reader = screen.getByRole("dialog", { name: "Cake" });
    expect(reader.textContent).toContain(live.text.trim());
    const completed = {
      ...live,
      id: "saved-response",
      entryId: "saved-entry",
      text: `${live.text}Done.`,
      status: "complete" as const,
    };
    fixture.publish([{ ...answer, text: "S".repeat(499) }, completed]);
    expect(screen.getByRole("dialog", { name: "Cake" })).toBe(reader);
    expect(reader.textContent).toContain("Done.");
    expect(setOpen.mock.calls.map(([, open]) => open)).toEqual([true]);
    await fixture.user.click(within(reader).getByRole("button", { name: "Exit fullscreen Cake" }));
    expect(screen.queryByRole("dialog", { name: "Cake" })).toBeNull();
    expect(setOpen.mock.calls.map(([, open]) => open)).toEqual([true, false]);
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    const response = screen.getByText(/A live response\..*Done\./).closest('[data-slot="message"]');
    if (!(response instanceof HTMLElement)) throw new Error("Missing completed response");
    await fixture.user.click(within(response).getByRole("button", { name: "Copy response" }));
    expect(copy).toHaveBeenCalledWith(completed.text);
  });

  it("counts a background start and successive waits as one work-log item while the turn settles", async () => {
    const handleId = "10000000-0000-4000-8000-000000000007";
    const model = {
      prefer: "exact",
      provider: "fixture",
      modelId: "fixture-model",
      thinkingLevel: "off",
    };
    const start: UiPart = {
      id: "background-start",
      kind: "tool",
      name: "cake",
      command: "subagents.start",
      input: JSON.stringify({ task: "Tell a joke", model }),
      output: JSON.stringify({ handleId, task: "Tell a joke", status: "running" }),
      state: "success",
    };
    const waiting: UiPart = {
      id: "background-wait-1",
      kind: "tool",
      name: "cake",
      command: "subagents.wait",
      input: JSON.stringify({ handleId }),
      output: JSON.stringify({ handleId, task: "Tell a joke", status: "running" }),
      state: "success",
    };
    using fixture = renderTranscriptRendering([start, waiting], { streaming: true });
    const summary = screen.getByText("Work log", { exact: true }).closest("summary");
    if (!summary) throw new Error("Missing background work log");
    expect(summary.textContent).toContain("1 tool call");
    await fixture.user.click(summary);
    // Inner work-log rows use a real virtualizer. Count/disclosure are observable
    // without inventing viewport measurements to force those rows into jsdom.
    const completed: UiPart = {
      ...waiting,
      id: "background-wait-2",
      output: JSON.stringify({
        handleId,
        task: "Tell a joke",
        status: "complete",
        resolvedModel: { ...model, requested: "exact", source: "exact", fallbacks: [] },
        parts: [{ id: "child-answer", kind: "text", text: "A compact joke.", status: "complete" }],
      }),
    };
    fixture.publish([start, waiting, completed]);
    expect(summary.closest("details")?.open).toBe(true);
    expect(summary.textContent).toContain("1 tool call");
    expect(summary.textContent).not.toContain("subagents.wait");
    expect(fixture.container.querySelector('[data-slot="loading-state"]')).toBeNull();
  });

  it("shows a failed operation's preserved technical details, copies them and allows dismissal", async () => {
    const failure = new Error("Model request failed");
    failure.stack = "Error: Model request failed\n    at provider.request (provider.ts:50:7)";
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => {
      throw failure;
    });
    using fixture = renderTranscriptRendering([], { client: { sessionChats: { prompt } } });
    const copy = vi.spyOn(navigator.clipboard, "writeText");
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "Please retry");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    const error = await screen.findByRole("alert");
    expect(within(error).getByText("Model request failed")).toBeDefined();
    await fixture.user.click(within(error).getByText("Technical details"));
    expect(within(error).getByText(/at provider\.request/).textContent).toBe(failure.stack);
    await fixture.user.click(
      within(error).getByRole("button", { name: "Copy full error details" }),
    );
    expect(copy).toHaveBeenCalledWith(failure.stack);
    expect(within(error).getByRole("button", { name: "Copied full error details" })).toBeDefined();
    await fixture.user.click(within(error).getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "transcript-rendering", text: "Please retry" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
