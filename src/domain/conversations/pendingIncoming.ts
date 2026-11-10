import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  formatSessionDigestReminder,
  sessionDigestParts,
} from "../../contracts/cake-chats/session-digest-reminder";
import type { SessionFamilyDocument } from "../../contracts/session-families/session-family-document";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { pendingReportPresentation } from "../../contracts/conversations/reference-notification";
import { passiveNoticeParts } from "../../services/pi/runtime/internal-input-projection";

/** Presentation only: no source-body retrieval, admission, wake, handling or permission changes. */
export function pendingIncomingParts(document: SessionFamilyDocument, sessionId: string): UiPart[] {
  const references = (document.deferredReferences ?? []).filter(
    (item) => item.recipientSessionId === sessionId && !item.attentionTodoId,
  );
  const presentation = pendingReportPresentation(references);
  const notices = (document.passiveNotices ?? []).filter(
    (item) => item.recipientSessionId === sessionId && !item.delivered,
  );
  const digest = (document.coordinatorDigest ?? [])
    .filter((item) => (item.coordinatorSessionId ?? CAKE_CHAT_SESSION_ID) === sessionId)
    .flatMap((item) => {
      const completion = document.completionInbox?.find((entry) => entry.id === item.id);
      const text = formatSessionDigestReminder({
        lines: [
          {
            reference: item.sessionId,
            sessionId: item.sessionId,
            title: item.title,
            status: item.status,
            summary: item.summary,
            autoMergeOutcome: item.autoMergeOutcome,
            resultMessageRef: item.resultMessageRef,
            references: completion?.references,
            kind: completion?.kind,
            decisions: completion?.decisions,
          },
        ],
        receiptIds: [item.id],
      });
      return text ? sessionDigestParts(text) : [];
    });
  return [
    ...digest,
    ...passiveNoticeParts({
      _tag: "UserWithReminders",
      text: "",
      notices,
      reportNotices: presentation.notices,
      updates: presentation.updates,
    }),
  ].map((part) => ({ ...part, pendingIncoming: true }));
}
