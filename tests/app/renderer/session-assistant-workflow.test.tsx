/** @vitest-environment jsdom */
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { assistantThread, renderSessionAssistant } from "./session-assistant-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
afterEach(cleanup);

// These exercise rendered state and service payloads, not native portal, focus,
// or parent-composer selection behavior (which needs Electron verification).
describe("Session assistant workflow", () => {
  it("sends parent composer selection with the first quick prompt only, then reuses the assistant without resending it", async () => {
    const ensure = vi.fn<Client["discussionSessions"]["ensureSessionAssistant"]>(async () => ({
      thread: assistantThread,
      turnId,
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
    using fixture = renderSessionAssistant(
      { discussionSessions: { ensureSessionAssistant: ensure }, sessionChats: { prompt } },
      { parentComposer: true },
    );
    const parentInput = screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
    await fixture.user.type(parentInput, "plan for later");
    // The event driver supplies textarea selection, without fake Range geometry,
    // window.getSelection mocks, or Store capture calls. This proves the outgoing
    // annotation contract, not Chromium's native selection/focus retention.
    await fixture.user.pointer([
      { target: parentInput, offset: 0, keys: "[MouseLeft>]" },
      { target: parentInput, offset: 4 },
      { target: parentInput, offset: 4, keys: "[/MouseLeft]" },
    ]);
    expect(parentInput.value.slice(parentInput.selectionStart, parentInput.selectionEnd)).toBe(
      "plan",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    const quick = within(screen.getByRole("dialog", { name: "Quick session assistant" }));
    await fixture.user.type(
      quick.getByRole("combobox", { name: "Ask session assistant" }),
      "Where is the plan?",
    );
    await fixture.user.click(quick.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(ensure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          firstPrompt: {
            text: "Where is the plan?",
            annotations: [
              expect.objectContaining({
                messageId: "composer-selection",
                selectedText: "plan",
                startOffset: 0,
                endOffset: 4,
              }),
            ],
          },
        }),
        expect.any(Object),
      ),
    );
    fixture.observe([], true);
    fixture.settle(turnId, "It is in docs/plan.md.", "Where is the plan?");
    expect(await screen.findByText("It is in docs/plan.md.")).toBeDefined();
    expect(parentInput.value).toBe("plan for later");
    // Clear the selection through a normal composer click before opening the
    // durable assistant. The original quick context must not leak into its send.
    await fixture.user.click(parentInput);
    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    const full = within(screen.getByRole("dialog", { name: "Session assistant chat" }));
    await fixture.user.type(
      full.getByRole("combobox", { name: "Message session assistant" }),
      "What next?",
    );
    await fixture.user.click(full.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sidecar-assistant",
        text: "What next?",
        attachments: [],
      }),
      expect.any(Object),
    );
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("starts a quick chat, waits for its reply, then reuses that conversation in full chat", async () => {
    const ensure = vi.fn<Client["discussionSessions"]["ensureSessionAssistant"]>(async () => ({
      thread: assistantThread,
      turnId,
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
    const abort = vi.fn<Client["sessionChats"]["abort"]>(async () => undefined);
    using fixture = renderSessionAssistant({
      discussionSessions: { ensureSessionAssistant: ensure },
      sessionChats: { prompt, abort },
    });

    await fixture.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
    await fixture.user.type(
      screen.getByRole("combobox", { name: "Ask session assistant" }),
      "Where is the plan?",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(ensure).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          parentSessionId: "parent-1",
          workingDirectory: "/project",
          staged: false,
          stagedMessages: [],
          firstPrompt: { text: "Where is the plan?", annotations: [] },
          tools: expect.any(Array),
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByRole("status", { name: "Session assistant is thinking" })).toBeDefined();
    expect(screen.queryByRole("combobox", { name: "Ask session assistant" })).toBeNull();
    fixture.observe(
      [
        {
          id: "user-1",
          kind: "text",
          role: "user",
          text: "Where is the plan?",
          status: "complete",
        },
      ],
      true,
    );
    expect(screen.getByRole("status", { name: "Session assistant is thinking" })).toBeDefined();
    expect(prompt).not.toHaveBeenCalled();
    fixture.settle(turnId, "It is in docs/plan.md.", "Where is the plan?");
    expect(await screen.findByText("It is in docs/plan.md.")).toBeDefined();
    expect(screen.queryByRole("status", { name: "Session assistant is thinking" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();

    await fixture.user.pointer({
      target: screen.getByRole("button", { name: "Ask session assistant" }),
      keys: "[MouseRight]",
    });
    expect(await screen.findByText("Session assistant")).toBeDefined();
    expect(screen.getByText("Where is the plan?")).toBeDefined();
    const fullInput = screen.getByRole("combobox", { name: "Message session assistant" });
    await fixture.user.type(fullInput, "Open the other session");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: "sidecar-assistant", text: "Open the other session" }),
        expect.any(Object),
      ),
    );
    expect(ensure).toHaveBeenCalledOnce();
    fixture.observe(
      [
        {
          id: "assistant-1",
          kind: "text",
          role: "assistant",
          text: "It is in docs/plan.md.",
          status: "complete",
        },
      ],
      true,
    );
    await fixture.user.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(abort).toHaveBeenCalledWith(
        { sessionId: "sidecar-assistant", stop: { by: "user" } },
        expect.any(Object),
      ),
    );
  });

  it.each([false, true])(
    "renders an already-settled first reply and supplies staged-parent context only when staged (%s)",
    async (staged) => {
      const ensure = vi.fn<Client["discussionSessions"]["ensureSessionAssistant"]>(async () => ({
        thread: assistantThread,
        turnId,
      }));
      const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
      using fixture = renderSessionAssistant(
        { discussionSessions: { ensureSessionAssistant: ensure }, sessionChats: { prompt } },
        { staged },
      );
      await fixture.user.click(screen.getByRole("button", { name: "Ask session assistant" }));
      await fixture.user.type(
        screen.getByRole("combobox", { name: "Ask session assistant" }),
        "Quick one",
      );
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() =>
        expect(ensure).toHaveBeenCalledWith(
          expect.objectContaining({
            staged,
            stagedMessages: staged ? [{ role: "user", text: "Draft the plan" }] : [],
            firstPrompt: { text: "Quick one", annotations: [] },
          }),
          expect.any(Object),
        ),
      );
      fixture.observe([
        { id: "user-1", kind: "text", role: "user", text: "Quick one", status: "complete" },
        { id: "assistant-1", kind: "text", role: "assistant", text: "Done.", status: "complete" },
      ]);
      expect(await screen.findByText("Done.")).toBeDefined();
      expect(prompt).not.toHaveBeenCalled();
      expect(screen.queryByRole("status", { name: "Session assistant is thinking" })).toBeNull();
    },
  );
});
