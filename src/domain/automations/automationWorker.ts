import { DateTime, Effect, Schedule, Stream } from "effect";
import type {
  AutomationOccurrenceSource,
  AutomationSourceEvent,
} from "../../contracts/automations/automation-data";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import { AutomationEvents } from "../../services/automations/AutomationEvents";
import { RuntimeRecoveryStorage } from "../../services/storage/RuntimeRecoveryStorage";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { matchesEvent } from "./automationPolicy";
import { acquireSession, drain, settle, startRun, trigger } from "./automationRuns";
import type { ArtifactSchedule } from "../../contracts/artifacts/artifact-schedules";
import { runArtifactSchedulePass } from "./artifactSchedules";

export const acceptEvent = Effect.fn("Automations.acceptEvent")(function* (
  event: AutomationSourceEvent,
) {
  const records = yield* AutomationRecords;
  for (const automation of records.snapshot().automations) {
    if (
      automation.state._tag !== "active" ||
      automation.definition.trigger._tag !== "Event" ||
      !matchesEvent(automation.definition.trigger.filter, event)
    )
      continue;
    // Pi recovery re-admits the same durable input identity; its occurrence records admission.
    if (
      records
        .snapshot()
        .occurrences.some(
          (item) =>
            item.automationId === automation.id &&
            item.source._tag === "Event" &&
            item.source.eventId === event.eventId,
        )
    )
      continue;
    const source: AutomationOccurrenceSource = {
      _tag: "Event",
      eventId: event.eventId,
      event: event.event,
      sourceSessionId: event.sourceSessionId,
    };
    if (event.projectPath !== undefined) Object.assign(source, { projectPath: event.projectPath });
    if (event.sourceMessageId !== undefined)
      Object.assign(source, { sourceMessageId: event.sourceMessageId });
    yield* trigger(automation.id, source).pipe(
      Effect.tapError((error) => Effect.logError("Automation event execution failed", error)),
      Effect.ignore,
    );
  }
});

export const runSchedulePass = Effect.fn("Automations.runSchedulePass")(function* () {
  const now = DateTime.formatIso(yield* DateTime.now);
  const records = yield* AutomationRecords;
  const due = records
    .snapshot()
    .automations.filter(
      (item) =>
        item.state._tag === "active" &&
        item.nextScheduledAt !== undefined &&
        item.nextScheduledAt <= now,
    );
  for (const automation of due) {
    if (automation.nextScheduledAt === undefined) continue;
    yield* trigger(automation.id, {
      _tag: "Schedule",
      scheduledAt: automation.nextScheduledAt,
    }).pipe(
      Effect.tapError((error) => Effect.logError("Scheduled automation execution failed", error)),
      Effect.ignore,
    );
  }
});

/** Reuse Pi's existing input receipts/checkpoints. Never resubmit the saved task prompt. */
export const recover = Effect.fn("Automations.recover")(function* () {
  const records = yield* AutomationRecords;
  const recovery = yield* RuntimeRecoveryStorage;
  const sessions = yield* CakeSessionRuntimes;
  for (const run of records.snapshot().runs) {
    const result = yield* Effect.gen(function* () {
      const receipt = yield* recovery.get(run.sessionId);
      const webhook = records
        .snapshot()
        .occurrences.some((item) => item.id === run.occurrenceId && item.source._tag === "Webhook");
      // A historical run may own new accepted work without changing its original outcome.
      // Leave terminal/empty receipts alone so restart does not undo an explicit restore.
      if (
        run.status._tag !== "running" &&
        (!receipt ||
          receipt.inputs.length === 0 ||
          !["active", "blocked", "stopped"].includes(receipt.state))
      )
        return;
      if (!receipt) {
        // Pi writes its input receipt before it can start a turn. For a webhook the
        // occurrence is already durable, so a start interrupted before admission can resume.
        if (webhook) {
          yield* startRun(run);
          return;
        }
        yield* settle(
          run.id,
          "failed",
          "Execution did not reach Pi admission before the backend stopped. Review the run before trying again.",
        );
        return;
      }
      if (
        receipt.state === "complete" ||
        receipt.state === "failed" ||
        receipt.state === "stopped"
      ) {
        yield* settle(
          run.id,
          receipt.state === "complete"
            ? "complete"
            : receipt.state === "failed"
              ? "failed"
              : "aborted",
          receipt.issue,
        );
        return;
      }
      if (receipt.state === "blocked") {
        yield* settle(
          run.id,
          "failed",
          receipt.issue ?? "Interrupted work needs review in its session.",
        );
        return;
      }
      yield* Effect.scoped(
        Effect.gen(function* () {
          const recreateBeforeTranscript =
            webhook &&
            !receipt.transcriptPersisted &&
            !(yield* sessions.catalogEntry(
              {
                workingDirectory: run.workingDirectory,
                sessionDirectory: run.sessionDirectory,
                direct: true,
              },
              run.sessionId,
            ));
          const handle = yield* acquireSession(run.sessionId, recreateBeforeTranscript);
          yield* handle.recover(receipt.inputs);
          const status = yield* sessions.currentStatus(run);
          if (status?.recoveryIssue) yield* settle(run.id, "failed", status.recoveryIssue);
        }),
      );
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      yield* settle(run.id, "failed", result.failure.message);
      yield* Effect.logWarning("Automation restart recovery needs attention", result.failure);
    }
  }
  for (const automation of records.snapshot().automations) {
    if (automation.state._tag === "active") yield* drain(automation.id);
  }
});

export const runWebhookPass = Effect.fn("Automations.runWebhookPass")(function* () {
  const { automations, occurrences } = (yield* AutomationRecords).snapshot();
  const active = new Set(
    automations.filter((item) => item.state._tag === "active").map((item) => item.id),
  );
  const pending = new Set(
    occurrences
      .filter(
        (item) =>
          item.source._tag === "Webhook" &&
          item.disposition._tag === "queued" &&
          active.has(item.automationId),
      )
      .map((item) => item.automationId),
  );
  for (const id of pending) {
    yield* drain(id, true).pipe(
      Effect.tapError((error) => Effect.logError("Webhook automation dispatch failed", error)),
      Effect.ignore,
    );
  }
});

export const runWebhookWorker = runWebhookPass().pipe(Effect.repeat(Schedule.spaced("1 second")));

/** One worker tick: gated artifact schedules first, then prompt automations. */
export const runSchedulePasses = Effect.fn("Automations.runSchedulePasses")(function* <A, E, R>(
  invokeArtifactSchedule: (schedule: ArtifactSchedule) => Effect.Effect<A, E, R>,
) {
  yield* runArtifactSchedulePass(invokeArtifactSchedule).pipe(
    Effect.tapError((error) => Effect.logError("Artifact schedule pass failed", error)),
    Effect.ignore,
  );
  yield* runSchedulePass();
});
export const runScheduleWorker = <A, E, R>(
  invokeArtifactSchedule: (schedule: ArtifactSchedule) => Effect.Effect<A, E, R>,
) => runSchedulePasses(invokeArtifactSchedule).pipe(Effect.repeat(Schedule.spaced("1 second")));
export const runEventWorker = Effect.gen(function* () {
  const events = yield* AutomationEvents;
  yield* events.events().pipe(Stream.runForEach(acceptEvent));
});
