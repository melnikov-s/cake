/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
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

describe.each(["project", "cake-chat"] as const)("%s shared conversation lifecycle", (profile) => {
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
      { sessionId: fixture.sessionId },
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
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
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
