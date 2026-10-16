import { describe, expect, it } from "vitest";
import {
  describeCrossSessionMessage,
  encodeCrossSessionMessage,
  formatCrossSessionNoticeText,
  formatCrossSessionReportText,
  parseCrossSessionMessage,
  type CrossSessionMessageMetadata,
  type CrossSessionNotice,
} from "../../../src/contracts/conversations/cross-session-message";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { queuedUserMessageDisplay } from "../../../src/services/pi/runtime/session-projection";
import {
  addSessionDigestReminder,
  formatSessionDigestReminder,
} from "../../../src/contracts/cake-chats/session-digest-reminder";

const childId = "4f1c2b3a-5d6e-4f70-8a9b-0c1d2e3f4a51";
const requestId = "8358c2b7-bd3c-42ee-9fec-fcb726b66c18";
const base = {
  version: 1,
  messageId: "f6debbbd-ced1-4a12-b0f7-fb60c292c623",
  threadId: requestId,
  sequence: 1,
  expectsResponse: false,
} as const;
const fromChild: CrossSessionMessageMetadata = {
  ...base,
  sender: { sessionId: childId, title: "Fix the flaky test", kind: "project-session" },
};
const fromCakeChat: CrossSessionMessageMetadata = {
  ...base,
  expectsResponse: true,
  report: "digest",
  sender: { sessionId: CAKE_CHAT_SESSION_ID, title: "Cake Chat", kind: "cake-chat" },
};

/** Round-trips through the persisted text, as every consumer sees it. */
const roundTrip = (text: string, metadata: CrossSessionMessageMetadata) => {
  const parsed = parseCrossSessionMessage(encodeCrossSessionMessage(text, metadata));
  if (!parsed) throw new Error("Expected a parsed envelope");
  return describeCrossSessionMessage(parsed.text, parsed.metadata);
};

describe("cross-session message format", () => {
  it("keeps the persisted agent-facing text byte-for-byte stable", () => {
    expect(encodeCrossSessionMessage("Please review.", fromCakeChat)).toBe(
      `<cake-session-message>{"version":1,"messageId":"f6debbbd-ced1-4a12-b0f7-fb60c292c623","threadId":"${requestId}","sequence":1,"expectsResponse":true,"report":"digest","sender":{"sessionId":"${CAKE_CHAT_SESSION_ID}","title":"Cake Chat","kind":"cake-chat"}}</cake-session-message>\n\nPlease review.`,
    );
    expect(formatCrossSessionReportText(childId, "blocked", "Need a decision.")).toBe(
      `Session ${childId} — blocked\n\nNeed a decision.`,
    );
  });

  it("describes a Cake Chat request with its reply obligation and report mode", () => {
    expect(roundTrip("## Task\n\nFix it.", fromCakeChat)).toEqual({
      relation: "request",
      expectsResponse: true,
      report: "digest",
      body: "## Task\n\nFix it.",
    });
  });

  it.each(["result", "completed", "blocked", "failed"] as const)(
    "lifts the %s report lead line into structured status",
    (outcome) => {
      const described = roundTrip(
        formatCrossSessionReportText(childId, outcome, "**Done** with details."),
        { ...fromChild, replyToMessageId: requestId },
      );
      expect(described).toMatchObject({
        relation: "reply",
        outcome,
        body: "**Done** with details.",
      });
    },
  );

  const notices: CrossSessionNotice[] = [
    { kind: "canceled" },
    { kind: "failed" },
    { kind: "no-result" },
    { kind: "no-reply", requestMessageId: requestId },
    { kind: "interrupted", reason: "canceled", requestMessageId: requestId },
    { kind: "interrupted", reason: "failed", requestMessageId: requestId },
    { kind: "interrupted", reason: "stopped", requestMessageId: requestId },
    { kind: "stopped", stoppedBy: "stopped by the user (wrong project)" },
    {
      kind: "interrupted",
      reason: "canceled",
      requestMessageId: requestId,
      stoppedBy: "stopped by Cake Chat",
    },
  ];
  it.each(notices)("recognizes every generated notice it produces (%o)", (notice) => {
    const described = roundTrip(formatCrossSessionNoticeText(childId, notice), {
      ...fromChild,
      generatedNotice: true,
    });
    expect(described).toMatchObject({ relation: "notice", notice, body: "" });
  });

  it("keeps unrecognized or spoofed lead text whole instead of dropping content", () => {
    // An unknown outcome and a lead naming a different session are ordinary prose.
    for (const text of [
      `Session ${childId} — postponed\n\nLater.`,
      `Session other-session — completed\n\nNot mine.`,
    ])
      expect(roundTrip(text, fromChild)).toEqual({
        relation: "request",
        expectsResponse: false,
        body: text,
      });
    expect(
      roundTrip(`Session ${childId} exploded unexpectedly.`, {
        ...fromChild,
        generatedNotice: true,
      }),
    ).toMatchObject({ relation: "notice", body: `Session ${childId} exploded unexpectedly.` });
    // Notice wording without the generated flag stays the sender's words.
    const prose = formatCrossSessionNoticeText(childId, { kind: "canceled" });
    expect(roundTrip(prose, fromChild)).toMatchObject({ relation: "request", body: prose });
  });

  it.each([
    ["no envelope", "Plain user text"],
    ["unterminated", '<cake-session-message>{"version":1}\n\nBody'],
    ["invalid JSON", "<cake-session-message>{nope</cake-session-message>\n\nBody"],
    [
      "unknown version",
      `<cake-session-message>${JSON.stringify({ ...fromChild, version: 2 })}</cake-session-message>\n\nBody`,
    ],
    ["not leading", `Intro\n${encodeCrossSessionMessage("Body", fromChild)}`],
  ])("falls back to plain display for malformed input (%s)", (_name, text) => {
    expect(parseCrossSessionMessage(text)).toBeUndefined();
    expect(queuedUserMessageDisplay(text)).toMatchObject({ text, crossSession: undefined });
  });

  it("projects queued envelopes and reminders for display without the raw markup", () => {
    const display = queuedUserMessageDisplay(
      encodeCrossSessionMessage("**Queued** ask", fromChild),
    );
    expect(display).toMatchObject({
      text: "**Queued** ask",
      renderAs: "markdown",
      crossSession: { sender: { sessionId: childId } },
    });
    const reminder = formatSessionDigestReminder({
      lines: [
        {
          reference: "s:0c1d2e3f",
          sessionId: childId,
          title: "Fix the flaky test",
          status: "completed",
          summary: "Landed",
        },
      ],
      running: 0,
      interruptedReport: false,
    });
    expect(queuedUserMessageDisplay(addSessionDigestReminder("Next question", reminder)).text).toBe(
      "Next question",
    );
  });
});
