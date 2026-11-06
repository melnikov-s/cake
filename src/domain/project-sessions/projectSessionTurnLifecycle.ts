import { Effect, Option, Schedule } from "effect";
import { messageReference } from "../../contracts/conversations/message-reference";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import { substantiveTurnResult, implicitTurnResultFor } from "../../contracts/pi/turn-result-data";
import type { ProjectSessionLocation } from "../../contracts/project-sessions/project-session-data";
import type { CakeSessionRuntimeAcquireOptions } from "../../services/pi/CakeSessionRuntimes";
import { AutomationEvents } from "../../services/automations/AutomationEvents";
import { SessionCoordination } from "../../services/session-catalogs/SessionCoordination";
import { SessionCatalogChanges } from "../../services/session-catalogs/SessionCatalogChanges";
import { ProjectTodoReports } from "../../services/projects/ProjectTodoReports";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";
import { setSessionUnread } from "../application/application";
import { publishProjectSession as publishProjectAutomationEvent } from "../automations/automationSourceEvents";
import * as sessionFamilyAdmission from "../session-families/sessionFamilyAdmission";
import * as workflowLifecycle from "../workflows/workflow-lifecycle";
import { resolutionNamespace } from "./projectSessionResolution";

type TurnLifecycle = Required<
  Pick<
    CakeSessionRuntimeAcquireOptions,
    "onTurnActivityChanged" | "onSessionCreated" | "admitTurn" | "onTurnSettled"
  >
>;

/** Captures authorities, not snapshots: admission and settlement read current family state. */
export const makeTurnLifecycle = Effect.fn("ProjectSessions.makeTurnLifecycle")(function* ({
  sessionId,
  location,
}: {
  readonly sessionId: string;
  readonly location: ProjectSessionLocation;
}) {
  const application = yield* ApplicationState;
  const archive = yield* SessionArchiveStorage;
  const families = yield* SessionFamilyStorage;
  const workflowSupervisor = yield* WorkflowSupervisor;
  const coordination = yield* SessionCoordination;
  const catalogs = yield* SessionCatalogChanges;
  const configuration = yield* ProjectSessionConfiguration;
  const automationEvents = yield* Effect.serviceOption(AutomationEvents);
  const todoReports = yield* Effect.serviceOption(ProjectTodoReports);
  const publishActivity = catalogs.publish({
    _tag: "ProjectSessionActivityChanged",
    sessionId,
    projectPath: location.projectPath,
    workingDirectory: location.workingDirectory,
    sessionDirectory: location.sessionDirectory,
  });
  // A finished turn is durably unread until a window shows it, so sessions no window
  // observes still surface completion. The cheap activity event carries the flag.
  const markFinishedTurnUnread = Effect.gen(function* () {
    const namespace = yield* resolutionNamespace(sessionId, {
      cwd: location.workingDirectory,
      activeRoot: location.sessionDirectory,
      resolvedRoot: location.resolvedSessionDirectory,
    });
    if (namespace === "resolved") return;
    yield* setSessionUnread(sessionId, true);
    yield* publishActivity;
  }).pipe(
    Effect.provideService(ApplicationState, application),
    Effect.provideService(SessionFamilyStorage, families),
    Effect.provideService(SessionArchiveStorage, archive),
    // Unread metadata is best-effort; defects and cancellation are not persistence failures.
    Effect.catch((error) => Effect.logWarning("Could not mark finished turn unread", error)),
  );
  const hooks: TurnLifecycle = {
    onTurnActivityChanged: publishActivity,
    onSessionCreated: Option.isSome(automationEvents)
      ? publishProjectAutomationEvent({
          event: "session-created",
          eventId: `created:${sessionId}`,
          sessionId,
          projectPath: location.projectPath,
        }).pipe(
          Effect.provideService(AutomationEvents, automationEvents.value),
          Effect.provideService(SessionFamilyStorage, families),
          Effect.tapError((error) => Effect.logWarning("Automation source event failed", error)),
          Effect.ignore,
        )
      : Effect.void,
    admitTurn: (input, accept) => {
      const message = parseCrossSessionMessage(input.text);
      const userText =
        input.internal === undefined
          ? input.text
          : input.internal._tag === "UserWithReminders"
            ? input.internal.userText
            : undefined;
      const sourceEvent =
        Option.isSome(automationEvents) &&
        userText !== undefined &&
        !message &&
        !parseScheduledMessage(input.text)
          ? publishProjectAutomationEvent({
              event: "user-message-received",
              eventId: input.turnId,
              sessionId,
              projectPath: location.projectPath,
              text: userText,
            }).pipe(
              Effect.provideService(AutomationEvents, automationEvents.value),
              Effect.provideService(SessionFamilyStorage, families),
              Effect.tapError((error) =>
                Effect.logWarning("Automation source event failed", error),
              ),
              Effect.ignore,
            )
          : Effect.void;
      // Bind before Pi can settle a fast turn; the existing family policy still owns admission.
      const admit = message
        ? coordination
            .bindTurn(sessionId, message.metadata.messageId, input.turnId)
            .pipe(Effect.andThen(accept))
        : accept;
      return coordination.checkStorage().pipe(
        Effect.andThen(
          sessionFamilyAdmission
            .admitTurn(
              sessionId,
              {
                cwd: location.workingDirectory,
                activeRoot: configuration.sessionDirectory,
                resolvedRoot: configuration.resolvedSessionDirectory,
              },
              input,
              admit.pipe(Effect.andThen(sourceEvent)),
            )
            .pipe(
              Effect.provideService(SessionFamilyStorage, families),
              Effect.provideService(SessionArchiveStorage, archive),
            ),
        ),
      );
    },
    onTurnSettled: (event) =>
      Effect.gen(function* () {
        if (
          Option.isSome(automationEvents) &&
          event.outcome === "complete" &&
          event.result?.stopReason === "stop" &&
          event.result.entryId
        )
          yield* publishProjectAutomationEvent({
            event: "assistant-response-completed",
            eventId: `${sessionId}:${event.result.entryId}`,
            sessionId,
            projectPath: location.projectPath,
            sourceMessageId: event.result.entryId,
            text: event.result.text,
          }).pipe(
            Effect.provideService(AutomationEvents, automationEvents.value),
            Effect.provideService(SessionFamilyStorage, families),
            Effect.tapError((error) => Effect.logWarning("Automation source event failed", error)),
            Effect.ignore,
          );
        const boardDeliveries = (yield* families.state()).boardDeliveries ?? [];
        if (boardDeliveries.some((item) => item.turnId === event.turnId))
          yield* families.updateBoardDelivery(
            event.turnId,
            event.outcome === "complete"
              ? "consumed"
              : event.outcome === "aborted"
                ? "canceled"
                : "failed",
            event.message,
          );
        if (
          (event.outcome === "aborted" || event.outcome === "failed") &&
          boardDeliveries.some((item) => item.recipientSessionId === sessionId)
        )
          yield* families.setBoardDeliveryPaused(sessionId, true);
        yield* coordination.settleTurn(event.turnId, event.outcome);
        if (event.outcome !== "aborted") yield* markFinishedTurnUnread;
        const workflowOwnsCompletion = yield* workflowLifecycle
          .holdsTurnCompletion(sessionId, event.turnId)
          .pipe(Effect.provideService(WorkflowSupervisor, workflowSupervisor));
        const familyTurn = (yield* families.state()).turns.find(
          (turn) => turn.turnId === event.turnId,
        );
        // An explicit report was already queued when recorded; do not summarize it twice.
        const todoReport = familyTurn?.report ? undefined : substantiveTurnResult(event.result);
        if (event.outcome !== "aborted" && todoReport && Option.isSome(todoReports))
          yield* todoReports.value.offer({
            projectPath: location.projectPath,
            sessionId,
            text: todoReport,
          });
        if (workflowOwnsCompletion && familyTurn) return;
        // Only an answer to the requester itself may become its implicit result.
        const text = familyTurn
          ? implicitTurnResultFor(event.result, familyTurn.senderSessionId)
          : undefined;
        const failed = event.outcome === "failed" || event.result?.stopReason === "error";
        const outcome = event.outcome === "aborted" ? "aborted" : failed ? "failed" : "complete";
        const diagnostic = (event.message ?? event.result?.errorMessage)?.trim().slice(0, 100_000);
        const report =
          failed && diagnostic
            ? { outcome: "failed" as const, text: diagnostic }
            : text
              ? { outcome: "result" as const, text }
              : undefined;
        const resultMessageRef = event.result?.entryId
          ? messageReference(sessionId, event.result.entryId)
          : undefined;
        yield* families
          .settleTurn(
            event.turnId,
            outcome,
            report ? { ...report, ...(resultMessageRef ? { resultMessageRef } : null) } : undefined,
            event.stop,
          )
          .pipe(
            Effect.tapError((error) =>
              Effect.logError("Retrying durable session settlement", error),
            ),
            Effect.retry(Schedule.spaced("1 second")),
          );
      }),
  };
  return hooks;
});
