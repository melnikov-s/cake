import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import type { PendingReport } from "../../contracts/conversations/pending-report";
import {
  addReferenceNotifications,
  pendingReportPresentation,
} from "../../contracts/conversations/reference-notification";
import { ProjectError } from "../../contracts/projects/project-error";
import { isCakeChatTodoScope, projectTodoSessionIds } from "../../contracts/projects/project-todos";
import { parseSubagentLink } from "../../contracts/subagents/subagent-reference";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { projectChatSessionId } from "../cake-chats/cakeChatLocations";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import * as todos from "./projectTodos";
import { prepareCoordinatorNotice } from "../conversations/taskInputs";

/** Called under notice delivery serialization. The existing durable report inbox owns the handoff. */
export const hold = Effect.fn("ProjectTodoAttention.hold")(function* (
  report: PendingReport,
  origin: {
    sessionId: string;
    label: string;
    subagent?: { parentSessionId: string; handleId: string };
  },
  turnIds: readonly string[] = [],
) {
  const scope = yield* todos.scopeForChat(report.recipientSessionId);
  if (scope === undefined) return false;
  const storage = yield* SessionFamilyStorage;
  const document = yield* storage.state();
  if (
    document.deferredReferences?.some((item) => item.id === report.id) ||
    document.handledReports?.some((item) => item.id === report.id)
  )
    return true;
  const item = (yield* todos.list(scope)).items.find(
    (item) =>
      item.state === "open" &&
      (origin.subagent
        ? item.associations.some((link) => {
            const worker =
              link.kind === "subagent"
                ? link
                : link.kind === "source"
                  ? parseSubagentLink(link.ref)
                  : undefined;
            return (
              worker?.parentSessionId === origin.subagent?.parentSessionId &&
              worker?.handleId === origin.subagent?.handleId
            );
          })
        : projectTodoSessionIds(item).includes(origin.sessionId)),
  );
  if (!item) return false;
  const text = yield* prepareCoordinatorNotice(report.recipientSessionId, report.text);
  const label = text === report.text ? origin.label || item.title : item.title;
  if (!item.needsAttention)
    yield* todos.update(scope, {
      id: item.id,
      expectedRevision: item.revision,
      needsAttention: true,
      attentionReason: `Open result: ${label}`.slice(0, 512).trim(),
    });
  yield* storage.deferReferenceNotice({ ...report, text, attentionTodoId: item.id }, turnIds);
  return true;
});

/** Only an explicit pill click admits held originals. X continues to use SetAttention(false). */
export const activate = Effect.fn("ProjectTodoAttention.activate")(
  function* (scope: string, id: string, expectedRevision: number) {
    const storage = yield* SessionFamilyStorage;
    return yield* storage.withNoticeDelivery(
      Effect.gen(function* () {
        const item = yield* todos.read(scope, id);
        if (
          item.revision !== expectedRevision ||
          !item.needsAttention ||
          item.state !== "open" ||
          item.snoozedUntil
        )
          return yield* new ProjectError({
            operation: "activateAttention",
            message: "This attention item changed. Try again.",
          });
        const sessionId = isCakeChatTodoScope(scope)
          ? CAKE_CHAT_SESSION_ID
          : projectChatSessionId(scope);
        const reports = ((yield* storage.state()).deferredReferences ?? []).filter(
          (report) => report.recipientSessionId === sessionId && report.attentionTodoId === id,
        );
        const first = reports[0];
        if (first) {
          const handle = yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
          const turnId = first.id;
          const receipt = handle.inputReceipt ? yield* handle.inputReceipt(turnId) : undefined;
          if (!receipt) {
            const preparedReports: PendingReport[] = [];
            for (const report of reports)
              preparedReports.push({
                ...report,
                text: yield* prepareCoordinatorNotice(sessionId, report.text),
              });
            const presentation = pendingReportPresentation(preparedReports);
            yield* handle.submit({
              turnId,
              delivery: (yield* handle.snapshot()).streaming ? "follow-up" : "prompt",
              text: addReferenceNotifications(
                "The user opened this to-do's held results. Show the original result and explain the outcome. This is not approval to merge, complete a to-do, or resolve sessions.",
                preparedReports,
              ),
              attachments: [],
              markdown: false,
              automaticTitle: false,
              internal: {
                _tag: "UpdateBatch",
                notices: [],
                reportNotices: presentation.notices,
                updates: presentation.updates,
              },
            });
          }
          yield* storage.markReferenceAdmissions(reports.map((report) => report.id));
          yield* storage.releaseAttentionReports(sessionId, id);
          yield* handle.publishSessionChanged();
        }
        // Re-read after admission so advisory description updates don't lose a successful click.
        const current = yield* todos.read(scope, id);
        if (current.needsAttention && current.attentionReason === item.attentionReason)
          yield* todos.mutateUser(scope, {
            _tag: "SetAttention",
            id,
            expectedRevision: current.revision,
            needsAttention: false,
          });
        return yield* todos.list(scope);
      }),
    );
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((error) =>
        error._tag === "ProjectError"
          ? error
          : new ProjectError({ operation: "activateAttention", message: error.message }),
      ),
    ),
);
