/** @vitest-environment jsdom */
import { act, cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TurnId } from "../../../src/contracts/conversations/conversation-data";
import { DELIVERY_STALL_MS } from "../../../src/renderer/stores/ConversationDeliveryStore";
import { deliveryGate } from "./conversation-delivery-workflow-fixture";
import { renderConversationSession } from "./conversation-session-workflow-fixture";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// A delivery that never answers used to leave the composer "Churning" forever, with the
// person's text gone. After a short wait it must offer Cancel, and the text must survive.
describe.each(["project", "project-chat"] as const)("%s stalled send", (profile) => {
  const send = async (fixture: ReturnType<typeof renderConversationSession>) => {
    // An observed, idle conversation: the send goes straight to admission, not the queue.
    fixture.publish({ streaming: false });
    const input = screen.getByRole<HTMLTextAreaElement>("combobox", { name: fixture.inputLabel });
    await fixture.user.click(input);
    await fixture.user.type(input, "Ship the fix{Enter}");
    expect(input.value).toBe("");
    return input;
  };

  it("offers Cancel once a send stalls, and canceling returns the draft", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const prompt = vi.fn(
      (_input: unknown, _options?: { signal?: AbortSignal }) => deliveryGate<TurnId>().promise,
    );
    using fixture = renderConversationSession(profile, { sessionChats: { prompt } }, []);
    const input = await send(fixture);
    expect(screen.queryByText("Still sending…")).toBeNull();
    await act(async () => vi.advanceTimersByTime(DELIVERY_STALL_MS));
    const notice = screen.getByText("Still sending…");
    await fixture.user.click(within(notice).getByRole("button", { name: "Cancel" }));
    expect(input.value).toBe("Ship the fix");
    expect(prompt.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.queryByText("Still sending…")).toBeNull();
    expect(
      within(screen.getByLabelText("Conversation")).queryByText("Ship the fix", { exact: true }),
    ).toBeNull();
    expect(fixture.composer.error).toBeUndefined();
  });

  it("keeps the draft and shows the error when a stalled send times out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const admission = deliveryGate<TurnId>();
    using fixture = renderConversationSession(
      profile,
      { sessionChats: { prompt: () => admission.promise } },
      [],
    );
    const input = await send(fixture);
    await act(async () => vi.advanceTimersByTime(DELIVERY_STALL_MS));
    expect(screen.getByText("Still sending…")).toBeDefined();
    await act(async () =>
      admission.reject(
        new Error("Cake could not hand this message to the agent. Try sending it again."),
      ),
    );
    expect(input.value).toBe("Ship the fix");
    expect(fixture.composer.error).toContain("could not hand this message");
    expect(screen.queryByText("Still sending…")).toBeNull();
  });
});
