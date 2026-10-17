/** @vitest-environment jsdom */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../src/renderer/client/Client";
import { composerInputSessionId, renderComposerInput } from "./composer-input-workflow-fixture";

afterEach(cleanup);

// Existing composer/delivery/queue/command/saved-draft workflows own their
// journeys. This is the remaining in-place canonical PartUpdated regression,
// not proof of native keyboard input or selection behavior.
describe("Composer input projection workflow", () => {
  it("sends prepared annotations once and leaves the next message free of captured context", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make("10000000-0000-4000-8000-000000000001"),
    );
    const annotation = {
      messageId: "assistant-1",
      selectedText: "important answer",
      startOffset: 3,
      endOffset: 19,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Go deeper",
    };
    using fixture = renderComposerInput(
      { sessionChats: { prompt } },
      {
        // The captured source predates the bounded recent transcript window.
        // Native inline marker placement is deliberately outside this payload test.
        parts: [
          {
            id: "assistant-2",
            entryId: "recent-assistant-entry",
            kind: "text",
            role: "assistant",
            text: "Continuing the earlier answer.",
            status: "complete",
          },
        ],
        annotations: [annotation],
      },
    );
    const input = screen.getByRole("combobox", { name: "Message" });
    const form = input.closest("form");
    if (!form) throw new Error("Missing composer form");
    expect(within(form).getByRole("button", { name: "View 1 annotation" })).toBeDefined();
    await fixture.user.type(input, "First message");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "First message",
        attachments: [{ kind: "annotation", annotations: [expect.objectContaining(annotation)] }],
      }),
      expect.any(Object),
    );
    expect(within(form).queryByRole("button", { name: "View 1 annotation" })).toBeNull();
    await fixture.user.type(input, "Next message");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(2));
    expect(prompt).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "Next message", attachments: [] }),
      expect.any(Object),
    );
  });

  it("reconciles the optimistic prompt when the same canonical user part completes in place", async () => {
    let accept!: (value: TurnId) => void;
    const admission = new Promise<TurnId>((resolve) => {
      accept = resolve;
    });
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(() => admission);
    using fixture = renderComposerInput({ sessionChats: { prompt } });
    await fixture.user.type(screen.getByRole("combobox", { name: "Message" }), "First message");
    await fixture.user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: composerInputSessionId, text: "First message" }),
        expect.any(Object),
      ),
    );
    expect(screen.getByText("You · sending")).toBeDefined();
    expect(screen.getAllByText("First message", { exact: true })).toHaveLength(1);
    fixture.publishPart({
      id: "canonical-user",
      entryId: "canonical-entry",
      kind: "text",
      role: "user",
      text: "First message",
      status: "streaming",
    });
    // An incomplete authoritative part must not prematurely consume admission
    // state. Completion updates the same projection Model, not a new snapshot.
    expect(screen.getByText("You · sending")).toBeDefined();
    fixture.publishPart({
      id: "canonical-user",
      entryId: "canonical-entry",
      kind: "text",
      role: "user",
      text: "First message",
      status: "complete",
    });
    await waitFor(() => expect(screen.queryByText("You · sending")).toBeNull());
    expect(screen.getAllByText("First message", { exact: true })).toHaveLength(1);
    await act(async () => {
      accept(TurnId.make("10000000-0000-4000-8000-000000000001"));
      await admission;
    });
    expect(screen.getAllByText("First message", { exact: true })).toHaveLength(1);
    expect(screen.getByRole<HTMLTextAreaElement>("combobox", { name: "Message" }).value).toBe("");
  });
});
