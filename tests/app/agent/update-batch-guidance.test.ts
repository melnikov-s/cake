import { expect, it } from "vitest";
import { passiveNoticeContext } from "../../../src/contracts/conversations/passive-notice";
it("does not require replies or report-tool acknowledgments for passive notices", () => {
  const context = passiveNoticeContext([
    {
      id: "notice",
      text: "Review finished.",
      crossSession: {
        version: 1,
        messageId: "20000000-0000-4000-8000-000000000001",
        threadId: "20000000-0000-4000-8000-000000000002",
        sequence: 1,
        expectsResponse: false,
        sender: { sessionId: "worker", title: "Review", kind: "project-session" },
      },
    },
  ]);
  expect(context).toContain("Review finished.");
  expect(context).not.toContain("sessions.reports.acknowledge");
});
