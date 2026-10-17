import { describe, expect, it } from "vitest";
import {
  isReferenceNotification,
  addReferenceNotifications,
  protectedResponseNotice,
} from "../../../src/contracts/conversations/reference-notification";
import { appendMessageReferences } from "../../../src/contracts/conversations/message-reference-forwarding";
import {
  encodeCrossSessionMessage,
  formatCrossSessionReportText,
} from "../../../src/contracts/conversations/cross-session-message";
import { splitContextReminders } from "../../../src/services/pi/runtime/session-context-reminders";
import {
  formatSessionDigestReminder,
  addSessionDigestReminder,
} from "../../../src/contracts/cake-chats/session-digest-reminder";

const ref = "cake://session/task?message=exact%3Aentry";
const metadata = {
  version: 1 as const,
  messageId: "20000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000002",
  sequence: 1,
  expectsResponse: false,
  sender: { sessionId: "task", title: "Task", kind: "project-session" as const },
};

describe("passive reference notifications", () => {
  it.each([
    ref,
    `[Result](${ref})`,
    `- [Result](${ref})\n- [Report](cake://session/other)`,
    appendMessageReferences(protectedResponseNotice, [ref]),
    encodeCrossSessionMessage(formatCrossSessionReportText("task", "completed", ref), metadata),
  ])("recognizes only reference content: %s", (text) => {
    expect(isReferenceNotification(text)).toBe(true);
  });

  it.each([
    `Can you review ${ref}?`,
    `Blocked: need access. ${ref}`,
    `Implemented and tested. ${ref}`,
    "A background subagent finished, but its report was invalid.",
    protectedResponseNotice,
    "[Unrelated website](https://example.com)",
    "cake://session/task?attachment=not-a-message",
    encodeCrossSessionMessage(ref, { ...metadata, expectsResponse: true }),
    encodeCrossSessionMessage(formatCrossSessionReportText("task", "blocked", ref), metadata),
    encodeCrossSessionMessage(formatCrossSessionReportText("task", "failed", ref), metadata),
  ])("keeps substantive/actionable input immediate: %s", (text) => {
    expect(isReferenceNotification(text)).toBe(false);
  });

  it("projects exact references and digests as context without changing the user's words", () => {
    const digest = formatSessionDigestReminder({
      lines: [
        {
          reference: "s:12345678",
          sessionId: "task",
          title: "Task",
          status: "completed",
          summary: "Finished",
        },
      ],
      running: 0,
      interruptedReport: false,
    });
    const text = addReferenceNotifications(addSessionDigestReminder("Continue", digest), [ref]);
    const split = splitContextReminders(text);
    expect(split.text).toBe("Continue");
    expect(split.reminders.map((item) => item.title)).toEqual([
      "Cake · reference notifications",
      "Cake · session updates",
    ]);
    expect(split.reminders[0]?.text).toContain(ref);
    expect(addReferenceNotifications("Literal user input", [])).toBe("Literal user input");
  });
});
