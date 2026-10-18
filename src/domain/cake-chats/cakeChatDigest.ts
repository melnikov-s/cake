import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { UiPart } from "../../contracts/conversations/session-contract";
import {
  addSessionDigestReminder,
  formatSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";
import { sessionReference } from "../../contracts/project-sessions/session-reference";
import { CakeSessionRuntimes, type CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

/**
 * Whether Cake Chat's active run was started by a session report or worker result rather than
 * by the user. The newest consumed input owns the run: a user message steered into it would be
 * the last user part.
 */
export function runStartedByReport(parts: readonly UiPart[]): boolean {
  const input = parts.findLast(
    (part): part is Extract<UiPart, { kind: "text" }> =>
      part.kind === "text" && part.role === "user" && part.deliveryState === undefined,
  );
  return Boolean(input && (input.crossSession || input.subagentReport));
}

/**
 * The user's messages come first. A report-triggered run yields to a new user message, and the
 * quiet session inbox rides along as one Cake-owned reminder. The caller removes `digestIds`
 * only after Cake Chat accepted the message, so a failed send keeps the items.
 */
export const prepareUserMessage = Effect.fn("CakeChatDigest.prepareUserMessage")(function* (
  handle: CakeSessionHandle,
  text: string,
) {
  const snapshot = yield* handle.snapshot();
  const interruptedReport =
    handle.profile === "CakeChatSession" &&
    snapshot.streaming &&
    runStartedByReport(snapshot.parts);
  if (interruptedReport) yield* handle.abort();
  const storage = yield* SessionFamilyStorage;
  const admitted = handle.admittedDigestIds ? yield* handle.admittedDigestIds() : [];
  if (admitted.length) yield* storage.removeDigest(admitted);
  const state = yield* storage.state();
  const items = (state.coordinatorDigest ?? [])
    .filter((item) => (item.coordinatorSessionId ?? CAKE_CHAT_SESSION_ID) === snapshot.sessionId)
    .slice(0, 20);
  const knownIds = [
    ...new Set([
      ...items.map((item) => item.sessionId),
      ...state.spawnedSessions.map((spawn) => spawn.sessionId),
    ]),
  ];
  let running = 0;
  if (items.length) {
    const sessions = yield* CakeSessionRuntimes;
    const configuration = yield* Effect.serviceOption(ProjectSessionConfiguration);
    if (configuration._tag === "Some")
      for (const spawn of state.spawnedSessions.filter(
        (item) => item.requester.sessionId === snapshot.sessionId,
      )) {
        const status = yield* sessions.currentStatus({
          sessionId: spawn.sessionId,
          workingDirectory: spawn.workingDirectory,
          sessionDirectory: configuration.value.sessionDirectory,
        });
        if (status?.streaming) running += 1;
      }
  }
  const reminder = formatSessionDigestReminder({
    lines: items.map((item) => ({
      reference: sessionReference(item.sessionId, knownIds),
      sessionId: item.sessionId,
      title: item.title,
      status: item.status,
      summary: item.summary,
      resultMessageRef: item.resultMessageRef,
      references: state.completionInbox?.find((entry) => entry.id === item.id)?.references,
      kind: state.completionInbox?.find((entry) => entry.id === item.id)?.kind,
      decisions: state.completionInbox?.find((entry) => entry.id === item.id)?.decisions,
    })),
    running,
    interruptedReport,
    receiptIds: items.map((item) => item.id),
  });
  return {
    text: addSessionDigestReminder(text, reminder),
    digestIds: items.map((item) => item.id),
    interruptedReport,
  };
});
