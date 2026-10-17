/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createStore, mount } from "r-state-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/ipc/conversation-data";
import type { UiPart } from "../../../src/ipc/session-contract";
import type { Client } from "../../../src/renderer/client/Client";
import { Chat } from "../../../src/renderer/components/chat";
import { ChatStore } from "../../../src/renderer/stores/ChatStore";
import { chatSessionId, renderChatSurface } from "./chat-surface-workflow-fixture";
import { queuePart } from "./prompt-queue-workflow-fixture";
import { assistantThread, renderSessionAssistant } from "./session-assistant-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "execCommand");
});

// Complements chat-surface/configuration, conversation-delivery/session, saved-draft,
// scheduled-message and embedded-editor workflows rather than repeating their cases.
// These prove real renderer policy, payloads and content. Native Escape, selection,
// image paste and fullscreen/focus remain covered by the existing Electron suites.
describe("Chat composition", () => {
  it("queues a new draft instead of stopping the active response, then restores Stop", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
    const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
    using fixture = renderChatSurface({
      snapshot: { streaming: true },
      client: { sessionChats: { prompt, abort } },
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(screen.getByLabelText("Churning in progress")).toBeDefined();
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "One more thing");
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: chatSessionId, text: "One more thing" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(abort).not.toHaveBeenCalled();
    await fixture.user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(abort).toHaveBeenCalledWith(
        { sessionId: chatSessionId },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("retains the next draft while the previous delivery is pending and after it completes", async () => {
    let finish!: (id: TurnId) => void;
    const pending = new Promise<TurnId>((resolve) => {
      finish = resolve;
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => pending);
    using fixture = renderChatSurface({ client: { sessionChats: { prompt } } });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.type(input, "First instruction");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(input.disabled).toBe(false);
    await fixture.user.type(input, "Next instruction");
    await act(async () => {
      finish(turnId);
      await pending;
    });
    expect(input.value).toBe("Next instruction");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps sender and schedule provenance read-only and opens queued Markdown without sending it", async () => {
    const remove = vi.fn<Client["sessionChats"]["removeQueuedMessage"]>();
    const steer = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>();
    const setFullscreen = vi.fn<Client["electron"]["setFullscreenSurfaceOpen"]>(
      async () => undefined,
    );
    const report: UiPart = {
      id: "child-report",
      kind: "text",
      role: "user",
      text: "# Child report\n\n- Built the feature\n- Ran the tests",
      status: "complete",
      deliveryState: "queued",
      renderAs: "markdown",
      crossSession: {
        version: 1,
        messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
        threadId: "8358c2b7-bd3c-42ee-9fec-fcb726b66c18",
        sequence: 1,
        expectsResponse: false,
        sender: { sessionId: "child-session", title: "Feature child", kind: "project-session" },
      },
    };
    const scheduled: UiPart = {
      ...queuePart(1, "Check the build"),
      id: "scheduled",
      scheduled: {
        version: 1,
        id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
        createdAt: "2026-09-04T11:59:00.000Z",
        sendAt: "2026-09-04T12:02:00.000Z",
      },
    };
    using fixture = renderChatSurface({
      parts: [report, scheduled, { ...queuePart(2, "Editable prompt"), id: "editable" }],
      snapshot: { streaming: true },
      client: {
        sessionChats: { removeQueuedMessage: remove, steerQueuedMessage: steer },
        electron: { setFullscreenSurfaceOpen: setFullscreen },
      },
    });
    expect(screen.getByLabelText("Message from Feature child")).toBeDefined();
    expect(screen.getByLabelText(/^Scheduled message: scheduled/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /Edit queued prompt: # Child report/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit queued prompt: Check the build" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Edit queued prompt: Editable prompt" }),
    ).toBeDefined();
    await fixture.user.click(
      screen.getByRole("button", { name: /^View queued message: # Child report/ }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Child report" })).toBeDefined();
    expect(within(dialog).getAllByRole("listitem")).toHaveLength(2);
    expect(dialog.textContent).toContain("Feature child");
    expect(remove).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    await fixture.user.click(within(dialog).getByRole("button", { name: /Exit fullscreen/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(setFullscreen.mock.calls.map((call) => call[1])).toEqual([true, false]);
  });

  it.each([
    [39, "normal"],
    [40, "moderate"],
    [70, "high"],
    [90, "critical"],
  ] as const)("projects %i%% runtime context usage into the %s gauge", async (percent, state) => {
    using fixture = renderChatSurface({
      snapshot: {
        usage: {
          tokens: {
            input: percent * 1000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: percent * 1000,
          },
          cost: 0,
          context: { tokens: percent * 1000, contextWindow: 100000, percent },
        },
      },
    });
    const gauge = screen.getByLabelText(/context used/);
    expect(gauge.getAttribute("data-context-state")).toBe(state);
    await fixture.user.hover(gauge);
    expect((await screen.findByRole("tooltip")).textContent).toBe(
      `${percent}k / 100k tokens · Cache unknown`,
    );
  });

  it("asks for reword guidance and sends only the chosen text and prompt to the workspace service", async () => {
    // jsdom has no native undo API; exercise Chat's ordinary non-undo fallback.
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    const showMenu = vi.fn<Client["electron"]["showComposerContextMenu"]>(
      async () => "reword-with-prompt",
    );
    const reword = vi.fn<Client["workspaces"]["rewordComposerSelection"]>(
      async () => "concise request",
    );
    using fixture = renderChatSurface({
      client: {
        electron: { showComposerContextMenu: showMenu },
        workspaces: { rewordComposerSelection: reword },
      },
    });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.type(input, "Before rough ramble after");
    fireEvent.contextMenu(input);
    expect(showMenu).not.toHaveBeenCalled();
    await fixture.user.pointer([
      { target: input, offset: 7, keys: "[MouseLeft>]" },
      { target: input, offset: 19 },
      { target: input, offset: 19, keys: "[/MouseLeft]" },
    ]);
    // user-event right-mousedown collapses selection; dispatch only the menu
    // event after selecting through the driver, as in conversation-session-workflow.
    fireEvent.contextMenu(input);
    const prompt = await screen.findByRole("textbox", { name: "Reword prompt" });
    await fixture.user.type(prompt, "Make concise");
    await fixture.user.click(
      within(prompt.closest('[role="dialog"]')!).getByRole("button", { name: "Reword" }),
    );
    await waitFor(() =>
      expect(reword).toHaveBeenCalledWith(
        { selection: "rough ramble", prompt: "Make concise", workingDirectory: "/project" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(input.value).toBe("Before concise request after");
    expect(screen.queryByRole("textbox", { name: "Reword prompt" })).toBeNull();
  });

  it("keeps the parent configurable while pinning a live session assistant model", async () => {
    using fixture = renderSessionAssistant(
      {
        discussionSessions: {
          ensureSessionAssistant: async () => ({ thread: assistantThread, turnId }),
        },
      },
      { parentComposer: true },
    );
    expect(screen.getByRole("button", { name: "Model configuration" })).toBeDefined();
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    const assistant = within(screen.getByRole("dialog", { name: "Session assistant chat" }));
    expect(assistant.getByRole("combobox", { name: "Message session assistant" })).toBeDefined();
    expect(assistant.queryByRole("button", { name: "Model configuration" })).toBeNull();
  });
});

// Honest presentation-only exception: ProjectSession's ConversationSessionStore does
// not currently wire ChatStore.stoppable for idle subagents. Keep the public optional
// Chat capability contract without fake peer Stores or pretending it is a workflow.
describe("Chat optional presentation capability", () => {
  it("offers Stop for stoppable idle work", async () => {
    const abort = vi.fn(async () => undefined);
    using store = mount(
      createStore(ChatStore, {
        id: () => "stoppable-idle",
        parts: () => [],
        streaming: () => false,
        submitting: () => false,
        stoppable: () => true,
        configuration: () => undefined,
        commands: () => [],
        placeholder: () => "Message",
        inputLabel: () => "Message",
        canSubmit: () => false,
        submit: async () => false,
        abort,
      }),
    );
    const view = render(<Chat store={store} composerFocusEnabled={false} />);
    try {
      await userEvent.setup().click(screen.getByRole("button", { name: "Stop" }));
      expect(abort).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });
});
