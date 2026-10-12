/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import {
  deliveryGate,
  deliverySessionId,
  originalExchange,
  renderConversationDelivery,
} from "./conversation-delivery-workflow-fixture";

const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
const input = () => screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" });
afterEach(cleanup);

// Follow-up admission/retry, steering and per-item cancellation already run
// through shared Chat in prompt-queue-workflow.test.tsx. Composer failure/retry
// and preservation of a newer draft are covered in composer-workflow.test.tsx.
// These cases cover the remaining delivery projection and transcript-edit path,
// not native input/focus correctness.
describe("Conversation delivery workflow", () => {
  it("shows an idle send immediately and reconciles it with the authoritative transcript", async () => {
    const admission = deliveryGate<TurnId>();
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admission.promise);
    using fixture = renderConversationDelivery({ sessionChats: { prompt } });
    await fixture.user.type(input(), "Hello");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionId: deliverySessionId,
          text: "Hello",
          attachments: [],
          renderUserMessageAsMarkdown: false,
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
    expect(screen.getByText("You · sending")).toBeDefined();
    expect(screen.getAllByText("Hello", { exact: true })).toHaveLength(1);
    expect(input().value).toBe("");
    fixture.publish([
      {
        id: "canonical-user",
        entryId: "canonical-entry",
        kind: "text",
        role: "user",
        text: "Hello",
        status: "complete",
      },
    ]);
    expect(screen.getAllByText("Hello", { exact: true })).toHaveLength(1);
    expect(screen.queryByText("You · sending")).toBeNull();
    await act(async () => {
      admission.resolve(turnId);
      await admission.promise;
    });
    await fixture.user.type(input(), "Next request");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Send" }).disabled).toBe(false);
  });

  it.each(["Edited text", "Original text"])(
    "projects an edit in place and reconciles the replacement entry (%s)",
    async (text) => {
      const editing = deliveryGate<void>();
      const editMessage = vi.fn<Client["sessionChats"]["editMessage"]>(() => editing.promise);
      using fixture = renderConversationDelivery(
        { sessionChats: { editMessage } },
        originalExchange,
      );
      await fixture.user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
      expect(input().value).toBe("Original text");
      await fixture.user.clear(input());
      await fixture.user.type(input(), text);
      await fixture.user.click(screen.getByRole("button", { name: "Save and regenerate" }));
      await waitFor(() =>
        expect(editMessage).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            sessionId: deliverySessionId,
            entryId: "original-entry",
            text,
            attachments: [],
          }),
          expect.any(Object),
        ),
      );
      const conversation = within(screen.getByLabelText("Conversation"));
      const edited = conversation.getByText(text, { exact: true });
      const reply = conversation.getByText("Original reply", { exact: true });
      // Public transcript order is the regression: the optimistic edit must stay
      // before the original reply instead of becoming a new appended prompt.
      expect(edited.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
      expect(conversation.getByText("You · sending")).toBeDefined();
      expect(conversation.getAllByText(text, { exact: true })).toHaveLength(1);
      fixture.publish([]);
      expect(conversation.getByText(text, { exact: true })).toBeDefined();
      fixture.publish([
        {
          id: "replacement-user",
          entryId: "replacement-entry",
          kind: "text",
          role: "user",
          text,
          status: "complete",
        },
      ]);
      await waitFor(() => expect(conversation.queryByText("You · sending")).toBeNull());
      expect(conversation.getAllByText(text, { exact: true })).toHaveLength(1);
      await act(async () => {
        editing.resolve();
        await editing.promise;
      });
      expect(conversation.getAllByText(text, { exact: true })).toHaveLength(1);
    },
  );

  it("restores a failed transcript edit for retry without replacing the original exchange", async () => {
    const firstEdit = deliveryGate<void>();
    const editMessage = vi
      .fn<Client["sessionChats"]["editMessage"]>()
      .mockReturnValueOnce(firstEdit.promise)
      .mockResolvedValue(undefined);
    using fixture = renderConversationDelivery({ sessionChats: { editMessage } }, originalExchange);
    await fixture.user.click(screen.getByRole("button", { name: "Edit latest prompt" }));
    await fixture.user.clear(input());
    await fixture.user.type(input(), "Corrected text");
    await fixture.user.click(screen.getByRole("button", { name: "Save and regenerate" }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledOnce());
    expect(screen.getByText("Corrected text", { exact: true })).toBeDefined();
    await act(async () => {
      firstEdit.reject(new Error("Edit failed"));
      await firstEdit.promise.catch(() => undefined);
    });
    expect(await screen.findByText("Edit failed")).toBeDefined();
    expect(input().value).toBe("Corrected text");
    const conversation = within(screen.getByLabelText("Conversation"));
    expect(conversation.getByText("Original text")).toBeDefined();
    expect(conversation.getByText("Original reply")).toBeDefined();
    expect(conversation.queryByText("Corrected text")).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Save and regenerate" }));
    await waitFor(() => expect(editMessage).toHaveBeenCalledTimes(2));
    expect(editMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ entryId: "original-entry", text: "Corrected text" }),
      expect.any(Object),
    );
    fixture.publish([
      {
        id: "replacement-user",
        entryId: "replacement-entry",
        kind: "text",
        role: "user",
        text: "Corrected text",
        status: "complete",
      },
    ]);
    expect(conversation.getByText("Corrected text")).toBeDefined();
    expect(screen.queryByText("Edit failed")).toBeNull();
    expect(input().value).toBe("");
  });

  it("cancels an outstanding delivery when the renderer closes and handles its late failure", async () => {
    const admission = deliveryGate<TurnId>();
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admission.promise);
    const fixture = renderConversationDelivery({ sessionChats: { prompt } });
    try {
      await fixture.user.type(input(), "Pending message");
      await fixture.user.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      expect(screen.getByText("You · sending")).toBeDefined();
    } finally {
      fixture[Symbol.dispose]();
    }
    expect(prompt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => {
      admission.reject(new Error("Renderer closed"));
      await admission.promise.catch(() => undefined);
    });
  });
});
