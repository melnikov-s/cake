/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { renderTranscriptRendering } from "./transcript-rendering-workflow-fixture";

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

afterEach(cleanup);

// Native scroll opening/following/anchor restoration are owned by
// session-scroll-position.smoke.spec.ts. Selection, annotation highlights and
// fullscreen readers belong to message-selection/side-chat-streaming Electron
// suites. This suite does not fabricate those layout or native-event contracts.
describe("Projected transcript rendering workflows", () => {
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
