/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { renderChatSurface } from "./chat-surface-workflow-fixture";

afterEach(cleanup);
const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
const input = () => screen.getByRole("combobox", { name: "Message" });

describe("composer Enter scroll provenance", () => {
  it.each([false, true])(
    "waits for accepted input, including queued acceptance (streaming=%s)",
    async (streaming) => {
      let accept!: (id: TurnId) => void;
      const admission = new Promise<TurnId>((resolve) => {
        accept = resolve;
      });
      const prompt = vi.fn(() => admission);
      using fixture = renderChatSurface({
        snapshot: { streaming },
        client: { sessionChats: { prompt } },
      });
      const interaction = fixture.chat.transcriptInteraction;
      await fixture.user.type(input(), "Actual user message{enter}");
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(interaction.composerEnterRequestRevision).toBe(0);
      expect(interaction.transcriptScrollPosition).toEqual({ kind: "top" });
      await fixture.user.keyboard("{enter}{enter}");
      expect(prompt).toHaveBeenCalledOnce();
      expect(interaction.composerEnterRequestRevision).toBe(0);
      await act(async () => {
        accept(turnId);
        await admission;
      });
      await waitFor(() => expect(interaction.composerEnterRequestRevision).toBe(1));
      expect(interaction.bottomRequestRevision).toBe(0);
      expect(interaction.transcriptScrollPosition).toEqual({ kind: "bottom" });
      expect(input()).toHaveProperty("value", "");
    },
  );

  it("does not infer Enter from button, form, programmatic sends or incoming user/assistant/tool/reminder projections", async () => {
    const prompt = vi.fn(async () => turnId);
    using fixture = renderChatSurface({ client: { sessionChats: { prompt } } });
    const interaction = fixture.chat.transcriptInteraction;
    await fixture.user.type(input(), "Button message");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(input()).toHaveProperty("value", ""));
    await fixture.user.type(input(), "Form message");
    fireEvent.submit(input().closest("form")!);
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    await act(async () => {
      await fixture.chat.submit("Programmatic message");
    });
    fixture.publish([
      {
        kind: "text",
        id: "rehydrated-user",
        role: "user",
        status: "complete",
        text: "From elsewhere",
      },
      { kind: "text", id: "assistant", role: "assistant", status: "complete", text: "Reply" },
      { kind: "context", id: "reminder", title: "Reminder", text: "Background reminder" },
      {
        kind: "tool",
        id: "tool",
        name: "read",
        state: "success",
        input: "README.md",
        output: "Content",
      },
    ]);
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(interaction.composerEnterRequestRevision).toBe(0);
    expect(interaction.transcriptScrollPosition).toEqual({ kind: "top" });
  });

  it("does not submit for blank Enter, Shift+Enter, IME or keyCode 229", async () => {
    const prompt = vi.fn(async () => turnId);
    using fixture = renderChatSurface({ client: { sessionChats: { prompt } } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await fixture.user.type(input(), "Unfinished");
    fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.chat.transcriptInteraction.composerEnterRequestRevision).toBe(0);
  });

  it("does not force after failed submission, or reuse that intent for a later programmatic send", async () => {
    const prompt = vi
      .fn()
      .mockRejectedValueOnce(new Error("Admission rejected"))
      .mockResolvedValue(turnId);
    using fixture = renderChatSurface({ client: { sessionChats: { prompt } } });
    await fixture.user.type(input(), "Rejected message{enter}");
    await waitFor(() =>
      expect(screen.getByText("Admission rejected", { exact: true })).toBeDefined(),
    );
    expect(fixture.chat.transcriptInteraction.composerEnterRequestRevision).toBe(0);
    await act(async () => {
      await fixture.chat.submit("Later programmatic message");
    });
    expect(fixture.chat.transcriptInteraction.composerEnterRequestRevision).toBe(0);
  });
});
