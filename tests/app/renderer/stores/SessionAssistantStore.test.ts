/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { TurnId } from "../../../../src/contracts/conversations/conversation-data";
import type { Client } from "../../../../src/renderer/client/Client";
import {
  assistantThread,
  createSessionAssistantFixture,
} from "../session-assistant-workflow-fixture";

// Retained regression: the React workflow cannot honestly establish native
// parent-composer selection capture/retention. It covers creation, settlement,
// staged context, reuse and stopping; this tests the one-shot annotation policy
// after selection has been captured, not Electron selection correctness.
describe("SessionAssistantStore composer selection", () => {
  it("attaches the captured parent selection once and does not resend it", async () => {
    const turnId = TurnId.make("10000000-0000-4000-8000-000000000001");
    const ensure = vi.fn<Client["discussionSessions"]["ensureSessionAssistant"]>(async () => ({
      thread: assistantThread,
      turnId,
    }));
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () => turnId);
    using fixture = createSessionAssistantFixture({
      discussionSessions: { ensureSessionAssistant: ensure },
      sessionChats: { prompt },
    });
    fixture.assistant.beginQuickPrompt("plan");
    const submission = fixture.assistant.quickChatStore.submit("Where is the plan?");
    await vi.waitFor(() =>
      expect(ensure).toHaveBeenCalledWith(
        expect.objectContaining({
          firstPrompt: {
            text: "Where is the plan?",
            annotations: [
              expect.objectContaining({ selectedText: "plan", startOffset: 0, endOffset: 4 }),
            ],
          },
        }),
        expect.any(Object),
      ),
    );
    fixture.observe([], true);
    fixture.settle(turnId, "It is in docs/plan.md.", "Where is the plan?");
    await submission;
    // Use the full bootstrap adapter for the next prompt so the same one-shot
    // context policy runs again, now reusing the observed discussion.
    await fixture.assistant.bootstrapChatStore.submit("What next?");
    expect(prompt).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "sidecar-assistant",
        text: "What next?",
      }),
      expect.any(Object),
    );
    expect(prompt.mock.calls[0]?.[0].annotations).toBeUndefined();
  });
});
