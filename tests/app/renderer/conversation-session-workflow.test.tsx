/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  originalUserPart,
  queuedUserPart,
  renderConversationSession,
  workingAssistantPart,
} from "./conversation-session-workflow-fixture";

afterEach(cleanup);

// Keyboard-driven cases below prove form-to-service routing only, not native
// focus, typing, or keyboard capture. Electron owns those browser contracts.
describe.each(["project", "cake-chat"] as const)("%s shared conversation lifecycle", (profile) => {
  it("routes a selected reword request with its workspace context, blocks overlapping requests, and permits retry after a visible failure", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((_resolve, fail) => {
      reject = fail;
    });
    const showComposerContextMenu = vi.fn<Client["electron"]["showComposerContextMenu"]>(
      async () => "reword",
    );
    const rewordComposerSelection = vi
      .fn<Client["workspaces"]["rewordComposerSelection"]>()
      .mockReturnValueOnce(pending)
      .mockRejectedValueOnce(new Error("Reword retry unavailable"));
    using fixture = renderConversationSession(profile, {
      electron: { showComposerContextMenu },
      workspaces: { rewordComposerSelection },
    });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
    await fixture.user.type(input, "Rough wording");
    // Drive the textarea through the event driver; only Electron's native menu
    // is replaced at the Client boundary. This is service routing/availability,
    // not proof of Chromium selection retention, native undo or replacement.
    await fixture.user.pointer([
      { target: input, offset: 0, keys: "[MouseLeft>]" },
      { target: input, offset: 13 },
      { target: input, offset: 13, keys: "[/MouseLeft]" },
    ]);
    // user-event resets textarea selection on right-mousedown, unlike Chromium.
    // Dispatch the context-menu event itself without faking selection internals.
    fireEvent.contextMenu(input);
    await waitFor(() => expect(rewordComposerSelection).toHaveBeenCalledOnce());
    expect(showComposerContextMenu).toHaveBeenCalledWith(
      { selection: "Rough wording", x: 0, y: 0 },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(rewordComposerSelection).toHaveBeenCalledWith(
      profile === "project"
        ? { selection: "Rough wording", prompt: undefined, workingDirectory: "/project" }
        : { selection: "Rough wording", prompt: undefined },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(input.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("Rewording selection…")).toBeDefined();
    fireEvent.contextMenu(input);
    expect(showComposerContextMenu).toHaveBeenCalledOnce();
    expect(rewordComposerSelection).toHaveBeenCalledOnce();
    await act(async () => {
      reject(new Error("Reword service unavailable"));
      await pending.catch(() => undefined);
    });
    expect(await screen.findByText("Reword service unavailable")).toBeDefined();
    expect(screen.getByText("Reword failed")).toBeDefined();
    expect(input.getAttribute("aria-busy")).toBe("false");
    expect(input.value).toBe("Rough wording");
    // Reselect through the input before retrying. Native restoration is not a
    // precondition for this availability test and is not asserted in jsdom.
    await fixture.user.pointer([
      { target: input, offset: 0, keys: "[MouseLeft>]" },
      { target: input, offset: 13 },
      { target: input, offset: 13, keys: "[/MouseLeft]" },
    ]);
    fireEvent.contextMenu(input);
    expect(await screen.findByText("Reword retry unavailable")).toBeDefined();
    expect(rewordComposerSelection).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Reword service unavailable")).toBeNull();
    expect(input.getAttribute("aria-busy")).toBe("false");
    expect(input.value).toBe("Rough wording");
  });

  it("steers the first queued prompt from the empty Chat input, then stops and sends that steering head without sending a fresh prompt", async () => {
    const first = queuedUserPart("First queued prompt");
    const later = {
      ...queuedUserPart("Later queued prompt"),
      id: "later-part",
      queuedInput: {
        itemId: "20000000-0000-4000-8000-000000000002",
        text: "Later queued prompt",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      },
    };
    const steerQueuedMessage = vi.fn<Client["sessionChats"]["steerQueuedMessage"]>(async () => {
      fixture.publish({
        parts: [workingAssistantPart, { ...first, deliveryState: "steering" }, later],
      });
      return { steering: [], followUp: [] };
    });
    const sendQueuedMessageNow = vi.fn<Client["sessionChats"]["sendQueuedMessageNow"]>(async () => {
      fixture.publish({ parts: [workingAssistantPart, later] });
      return { steering: [], followUp: [] };
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    using fixture = renderConversationSession(
      profile,
      { sessionChats: { prompt, steerQueuedMessage, sendQueuedMessageNow } },
      [workingAssistantPart, first, later],
    );
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
    expect(input.value).toBe("");
    await fixture.user.click(input);
    await fixture.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(steerQueuedMessage).toHaveBeenCalledExactlyOnceWith(
        { sessionId: fixture.sessionId, partId: "queued-part" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      screen.getByRole("button", { name: "Cancel steering: First queued prompt" }),
    ).toBeDefined();
    expect(sendQueuedMessageNow).not.toHaveBeenCalled();
    await fixture.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(sendQueuedMessageNow).toHaveBeenCalledExactlyOnceWith(
        { sessionId: fixture.sessionId, partId: "queued-part" },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "View queued message: First queued prompt" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "View queued message: Later queued prompt" }),
    ).toBeDefined();
    expect(steerQueuedMessage).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("recovers from a failed stop, applies a live model command and retries an edited prompt", async () => {
    const stoppedAssistant = { ...workingAssistantPart, status: "complete" as const };
    const abort = vi
      .fn<Client["sessionChats"]["abort"]>()
      .mockRejectedValueOnce(new Error("Runtime could not stop"))
      .mockImplementationOnce(async () => {
        fixture.publish({ streaming: false, parts: [originalUserPart, stoppedAssistant] });
      });
    const setModel = vi.fn<Client["sessionChats"]["setModel"]>(async ({ provider, modelId }) => {
      fixture.publish({ model: { provider, id: modelId, name: "GPT-5" } });
    });
    const editMessage = vi
      .fn<Client["sessionChats"]["editMessage"]>()
      .mockRejectedValueOnce(new Error("Edit unavailable"))
      .mockImplementationOnce(async ({ text }) => {
        fixture.publish({ parts: [{ ...originalUserPart, text }, stoppedAssistant] });
      });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>();
    using fixture = renderConversationSession(profile, {
      sessionChats: { abort, setModel, editMessage, prompt },
    });
    const input = () =>
      screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });

    await fixture.user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByText("Runtime could not stop")).toBeDefined();
    expect(abort).toHaveBeenCalledWith(
      { sessionId: fixture.sessionId, stop: { by: "user" } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole("button", { name: "Stop" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Edit latest prompt" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("button", { name: "Edit latest prompt" })).toBeDefined();
    expect(abort).toHaveBeenCalledTimes(2);

    await fixture.user.type(input(), "/model openai/gpt-5");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model configuration" }).textContent).toContain(
        "GPT-5",
      ),
    );
    expect(setModel).toHaveBeenCalledWith(
      { sessionId: fixture.sessionId, provider: "openai", modelId: "gpt-5" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(input().value).toBe("");

    await fixture.user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
    expect(input().value).toBe("Original prompt");
    await fixture.user.clear(input());
    await fixture.user.type(input(), "Edited prompt");
    await fixture.user.click(screen.getByRole("button", { name: "Save and regenerate" }));
    expect(await screen.findByText("Edit unavailable")).toBeDefined();
    expect(input().value).toBe("Edited prompt");
    expect(screen.getByText("Original prompt")).toBeDefined();
    await fixture.user.click(screen.getByRole("button", { name: "Save and regenerate" }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledTimes(2));
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sessionId: fixture.sessionId,
        entryId: "user-entry",
        text: "Edited prompt",
        attachments: [],
        responseMode: "text",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(await screen.findByText("Edited prompt")).toBeDefined();
    expect(input().value).toBe("");
    expect(screen.queryByText("Edit unavailable")).toBeNull();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps an admitted queued prompt after a failed edit removal and restores it only after a successful retry", async () => {
    const queuedText = "Check the build";
    const removeQueuedMessage = vi
      .fn<Client["sessionChats"]["removeQueuedMessage"]>()
      .mockRejectedValueOnce(new Error("Queue edit unavailable"))
      .mockImplementationOnce(async () => {
        fixture.publish({ parts: [workingAssistantPart] });
        return { steering: [], followUp: [] };
      });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async ({ text }) => {
      fixture.publish({ parts: [workingAssistantPart, queuedUserPart(text)] });
      return TurnId.make("10000000-0000-4000-8000-000000000001");
    });
    using fixture = renderConversationSession(
      profile,
      { sessionChats: { removeQueuedMessage, prompt } },
      [workingAssistantPart, queuedUserPart(queuedText)],
    );
    const input = () =>
      screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
    const queued = () => within(screen.getByRole("list", { name: "Queued prompts" }));

    await fixture.user.click(
      screen.getByRole("button", { name: `Edit queued prompt: ${queuedText}` }),
    );
    expect(await screen.findByText("Queue edit unavailable")).toBeDefined();
    expect(
      queued().getByRole("button", { name: `View queued message: ${queuedText}` }),
    ).toBeDefined();
    expect(input().value).toBe("");
    expect(removeQueuedMessage).toHaveBeenCalledWith(
      { sessionId: fixture.sessionId, partId: "queued-part" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await fixture.user.click(
      screen.getByRole("button", { name: `Edit queued prompt: ${queuedText}` }),
    );
    await waitFor(() => expect(input().value).toBe(queuedText));
    expect(screen.queryByRole("list", { name: "Queued prompts" })).toBeNull();
    expect(removeQueuedMessage).toHaveBeenCalledTimes(2);
    await fixture.user.type(input(), " again");
    await fixture.user.click(screen.getByRole("button", { name: "Queue for later" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: fixture.sessionId,
        text: "Check the build again",
        attachments: [],
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      queued().getByRole("button", { name: "View queued message: Check the build again" }),
    ).toBeDefined();
    expect(input().value).toBe("");
    expect(screen.queryByText("Queue edit unavailable")).toBeNull();
  });
});
