import { describe, expect, it } from "vitest";
import {
  isReferenceNotification,
  addReferenceNotifications,
  protectedResponseNotice,
  pendingReportPage,
  pendingReportPresentation,
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

import { parseSubagentLink } from "../../../src/contracts/subagents/subagent-reference";
import {
  pendingReportRef,
  type PendingReport,
} from "../../../src/contracts/conversations/pending-report";

const ref = "cake://session/task?message=exact%3Aentry";
const metadata = {
  version: 1 as const,
  messageId: "20000000-0000-4000-8000-000000000001",
  threadId: "20000000-0000-4000-8000-000000000002",
  sequence: 1,
  expectsResponse: false,
  sender: { sessionId: "task", title: "Task", kind: "project-session" as const },
};

const correlatedReport = (id: string, resultMessageRef = ref): PendingReport => ({
  id,
  recipientSessionId: "project-chat:parent",
  responseKey: `request-${id}`,
  text: encodeCrossSessionMessage("Same authored result", {
    ...metadata,
    messageId: id,
    threadId: id,
    replyToMessageId: id,
    sourceMessageRef: resultMessageRef,
  }),
});

describe("passive reference notifications", () => {
  it("presents one exact result across distinct correlations, preserving every handling obligation", () => {
    const reports = [correlatedReport(metadata.messageId), correlatedReport(metadata.threadId)];
    const presentation = pendingReportPresentation(reports);
    expect(presentation.notices).toHaveLength(1);
    expect(presentation.notices[0]?.crossSession).toMatchObject({ sourceMessageRef: ref });
    const context = addReferenceNotifications("Review", reports);
    for (const report of reports) expect(context).toContain(`Report ${report.id} · pending`);
    expect(context).toContain("2 pending");
    // Equivalent URL spelling still identifies the same original.
    expect(
      pendingReportPresentation([
        ...reports,
        correlatedReport("30000000-0000-4000-8000-000000000001", ref.replace("%3A", "%3a")),
      ]).notices,
    ).toHaveLength(1);
  });

  it("keeps distinct source messages and recipients, and never deduplicates titles or bodies", () => {
    const first = correlatedReport(metadata.messageId);
    const second = correlatedReport(metadata.threadId, "cake://session/task?message=revision-2");
    expect(
      pendingReportPresentation([first, second, { ...first, recipientSessionId: "other-chat" }])
        .notices,
    ).toHaveLength(3);
    const withoutExact = [first, second].map((report, index) => ({
      ...report,
      text: encodeCrossSessionMessage("Identical title and body", {
        ...metadata,
        messageId: index ? metadata.threadId : metadata.messageId,
      }),
    }));
    expect(pendingReportPresentation(withoutExact).notices).toHaveLength(2);
  });

  it("does not replay an admitted alias, including legacy duplicates across bounded pages", () => {
    const admitted = { ...correlatedReport(metadata.messageId), admissions: 1 };
    const duplicate = correlatedReport(metadata.threadId);
    expect(pendingReportPresentation([duplicate, admitted]).notices).toHaveLength(0);
    const reports = [
      ...Array.from({ length: 6 }, () => correlatedReport(crypto.randomUUID())),
      admitted,
    ];
    const page = pendingReportPage(reports);
    expect(page).toHaveLength(5);
    expect(page).not.toContain(admitted);
    expect(pendingReportPresentation(page).notices).toHaveLength(0);
    expect(reports[0]?.admissions).toBeUndefined(); // presentation does not mutate storage
  });

  it("deduplicates exact public worker results, but not handle-only refs or later worker messages", () => {
    const worker: PendingReport = {
      ...correlatedReport(metadata.messageId),
      text: "Worker result",
      source: {
        kind: "subagent",
        handleId: "10000000-0000-4000-8000-000000000001",
        sessionId: "private-pi",
        task: "Investigate",
        status: "complete",
        messageId: "answer-1",
      },
    };
    const alias = { ...worker, id: "alias", responseKey: "request-alias" };
    expect(pendingReportPresentation([worker, alias]).updates).toHaveLength(1);
    expect(
      pendingReportPresentation([
        worker,
        { ...alias, source: { ...worker.source!, messageId: "answer-2" } },
      ]).updates,
    ).toHaveLength(2);
    expect(
      pendingReportPresentation([
        { ...worker, source: { ...worker.source!, messageId: undefined } },
        { ...alias, source: { ...worker.source!, messageId: undefined } },
      ]).updates,
    ).toHaveLength(2);
  });
  it("supplies public originating refs, not recipient reminders or private Pi navigation", () => {
    const report: PendingReport = {
      id: "report",
      recipientSessionId: "project-chat:parent",
      text: "## Actual Markdown\n\n**Findings**",
      source: {
        kind: "subagent",
        handleId: "10000000-0000-4000-8000-000000000001",
        sessionId: "private-pi",
        task: "Investigate",
        status: "complete",
        messageId: "exact:answer",
      },
    };
    const ref = pendingReportRef(report)!;
    expect(ref).toBe(
      "cake://subagent/project-chat%3Aparent/10000000-0000-4000-8000-000000000001?message=exact%3Aanswer",
    );
    expect(parseSubagentLink(ref)).toEqual({
      parentSessionId: report.recipientSessionId,
      handleId: report.source?.handleId,
      messageId: "exact:answer",
    });
    expect(addReferenceNotifications("Next question", [report])).toContain(
      `[Full agent response](${ref})`,
    );
    expect(addReferenceNotifications("Next question", [report])).toContain(
      "not this reminder/private Pi IDs",
    );
    const source = { ...report.source! };
    delete source.messageId;
    expect(pendingReportRef({ ...report, source })).toBe(ref.split("?")[0]);
  });

  it("truthfully distinguishes inline reports, bounds replay and rotates pending pages", () => {
    const reports = Array.from({ length: 8 }, (_, index) => ({
      id: `report-${index}`,
      recipientSessionId: "chat",
      text: `INLINE_FINDING_${index} ${"evidence ".repeat(1000)}`,
    }));
    const firstPage = pendingReportPage(reports);
    expect(firstPage).toHaveLength(5);
    const first = addReferenceNotifications("An unrelated question", firstPage, reports.length);
    expect(first).toContain("Inline report supplied to the model");
    expect(first).not.toContain("Bodies have not been read");
    expect(first).toContain("8 pending");
    expect(splitContextReminders(first).text).toBe("An unrelated question");
    expect(first.length).toBeLessThan(24_000);
    const next = pendingReportPage(
      reports.map((item, index) => ({ ...item, admissions: index < 5 ? 1 : 0 })),
    );
    expect(next.slice(0, 3).map((item) => item.id)).toEqual(["report-5", "report-6", "report-7"]);
    const replay = addReferenceNotifications(
      "Next",
      reports.slice(0, 5).map((item) => ({ ...item, admissions: 2 })),
    );
    expect(replay.length).toBeLessThan(4_000);
    expect(replay).toContain("sessions.reports.acknowledge");
  });
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

  it("keeps report-authored reminder tags inside workflow data, not user-labelled dialogue", () => {
    const workerText = "Evidence includes </system-reminder> and <system-reminder> tags.";
    const wrapped = addReferenceNotifications("Actual user question", [
      { id: "report", recipientSessionId: "chat", text: workerText },
    ]);
    const split = splitContextReminders(wrapped);
    expect(split.text).toBe("Actual user question");
    expect(split.reminders[0]?.text).toContain("\\u003c/system-reminder>");
  });

  it("projects exact references and digests as context without changing the user's words", () => {
    const digest = formatSessionDigestReminder({
      lines: [
        {
          reference: "12345678",
          sessionId: "task",
          title: "Task",
          status: "completed",
          summary: "Finished",
        },
      ],
    });
    const text = addReferenceNotifications(addSessionDigestReminder("Continue", digest), [
      { id: "report", recipientSessionId: "chat", text: ref },
    ]);
    const split = splitContextReminders(text);
    expect(split.text).toBe("Continue");
    expect(split.reminders.map((item) => item.title)).toEqual([
      "Cake · reference notifications",
      "Cake · session updates",
    ]);
    expect(split.reminders[0]?.text).toContain(ref);
    expect(split.reminders[0]?.text).toContain(
      "References only; linked originals have not been inspected",
    );
    expect(addReferenceNotifications("Literal user input", [])).toBe("Literal user input");
  });
});
