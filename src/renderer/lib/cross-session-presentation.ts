import {
  describeCrossSessionMessage,
  type CrossSessionMessageMetadata,
  type CrossSessionNotice,
  type CrossSessionReportOutcome,
} from "../../contracts/conversations/cross-session-message";

import {
  appendMessageReferences,
  messageReferencesInText,
} from "../../contracts/conversations/message-reference-forwarding";
import { protectedResponseNotice } from "../../contracts/conversations/reference-notification";

export interface CrossSessionBadge {
  readonly label: string;
  readonly tone: "default" | "accent" | "success" | "warning" | "destructive";
  readonly description: string;
}

/** Display-only projection; delivery and the agent-facing text remain unchanged. */
export interface CrossSessionPresentation {
  readonly relation: "request" | "reply" | "notice";
  readonly badges: readonly CrossSessionBadge[];
  /** Markdown body with Cake's own lead line or notice sentence translated out. */
  readonly body: string;
}

const outcomeBadges = {
  result: { label: "Result", tone: "default", description: "The session handed back a result." },
  completed: {
    label: "Completed",
    tone: "success",
    description: "The session reported its task completed.",
  },
  blocked: {
    label: "Blocked",
    tone: "warning",
    description: "The session cannot continue without a decision.",
  },
  failed: { label: "Failed", tone: "destructive", description: "The session reported a failure." },
} satisfies Record<CrossSessionReportOutcome, CrossSessionBadge>;

const stopped: CrossSessionBadge = {
  label: "Stopped",
  tone: "default",
  description: "The session stopped before handing back a result.",
};
const failed: CrossSessionBadge = {
  label: "Failed",
  tone: "destructive",
  description: "The session stopped with an error before handing back a result.",
};

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

interface NoticePresentation {
  readonly badge: CrossSessionBadge;
  readonly body: string;
}

function noticePresentation(notice: CrossSessionNotice): NoticePresentation {
  switch (notice.kind) {
    case "canceled":
      return { badge: stopped, body: "Canceled or interrupted before handing back a result." };
    case "failed":
      return { badge: failed, body: "Failed before handing back a result." };
    case "no-result":
      return {
        badge: { ...stopped, label: "No result" },
        body: "Stopped without a substantive result. This is not a successful completion.",
      };
    case "no-reply":
      return {
        badge: { ...stopped, label: "No reply" },
        body: "Stopped without replying to the request.",
      };
    case "stopped":
      return {
        badge: stopped,
        body: `${sentence(notice.stoppedBy)} before handing back a result.`,
      };
    case "interrupted":
      if (notice.stoppedBy)
        return {
          badge: stopped,
          body: `${sentence(notice.stoppedBy)} while working on a message.`,
        };
      return notice.reason === "failed"
        ? { badge: failed, body: "Stopped with an error while working on a message." }
        : {
            badge: stopped,
            body:
              notice.reason === "canceled"
                ? "Canceled or interrupted while working on a message."
                : "Stopped while working on a message.",
          };
  }
}

function replyBody(text: string): string {
  const references = messageReferencesInText(text);
  if (!references.length) return text;
  // Only remove Cake's exact generated footer. Authored links and prose stay intact;
  // the transcript independently presents these exact originals as lazy disclosures.
  const footer = appendMessageReferences("", references).trimStart();
  if (!text.endsWith(footer)) return text;
  const body = text.slice(0, -footer.length).trimEnd();
  return body === protectedResponseNotice ? "Response received." : body;
}

export function crossSessionPresentation(
  text: string,
  metadata: CrossSessionMessageMetadata,
): CrossSessionPresentation {
  const described = describeCrossSessionMessage(text, metadata);
  const badges: CrossSessionBadge[] = [];
  let body = described.relation === "reply" ? replyBody(described.body) : described.body;
  if (described.notice) {
    const notice = noticePresentation(described.notice);
    badges.push(notice.badge);
    body = notice.body;
  }
  if (described.outcome) badges.push(outcomeBadges[described.outcome]);
  if (described.expectsResponse)
    badges.push({
      label:
        described.resultDelivery === "notification" ? "Notification expected" : "Reply expected",
      tone: "accent",
      description:
        described.resultDelivery === "notification"
          ? "Completion is retained until the sender’s next user message; it does not start a turn."
          : "Application-confirmed completion automatically starts or queues a normal sender turn.",
    });
  return { relation: described.relation, badges, body };
}
