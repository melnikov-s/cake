import { DateTime, Effect, Schema, Struct } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  type ArtifactSchedule,
  ArtifactScheduleConfigureInput,
  type ArtifactScheduleIdentity,
} from "../../contracts/artifacts/artifact-schedules";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import { ClientEvents } from "../../services/clients/ClientEvents";
import { automationError, nextScheduledAt } from "./automationDefinitions";

const matches = (item: ArtifactSchedule, identity: ArtifactScheduleIdentity) =>
  item.lineageId === identity.lineageId && item.name === identity.name;

const invalidateExecution = Effect.fn("ArtifactSchedules.invalidateExecution")(function* (
  lineageId: ArtifactLineageId,
) {
  (yield* ClientEvents).broadcast({ type: "artifact-execution-invalidated", lineageId });
});

/** Reconfiguration replaces one named schedule; opening another view never creates a new identity. */
export const configureArtifactSchedule = Effect.fn("ArtifactSchedules.configure")(
  function* (input: ArtifactScheduleConfigureInput) {
    const validated = yield* Schema.decodeUnknownEffect(ArtifactScheduleConfigureInput)(input).pipe(
      Effect.mapError((cause) => automationError("artifact.schedule.configure", cause.message)),
    );
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const next = yield* nextScheduledAt(validated.schedule, now);
    if (next === undefined)
      return yield* automationError(
        "artifact.schedule.configure",
        "A one-time schedule must be in the future.",
      );
    const records = yield* AutomationRecords;
    return yield* records.transact((ledger) => {
      const previous = ledger.artifactSchedules.find((item) => matches(item, validated));
      const schedule: ArtifactSchedule = {
        ...validated,
        paused: ledger.pausedArtifactIds.includes(validated.lineageId),
        nextScheduledAt: next,
      };
      if (previous !== undefined)
        Object.assign(schedule, Struct.pick(previous, ["lastRunAt", "lastOutcome", "lastError"]));
      return Effect.succeed({
        ledger: {
          ...ledger,
          artifactSchedules: [
            ...ledger.artifactSchedules.filter((item) => !matches(item, validated)),
            schedule,
          ],
        },
        result: schedule,
      });
    });
  },
  (effect, input) => effect.pipe(Effect.tap(() => invalidateExecution(input.lineageId))),
);

export const listArtifactSchedules = Effect.fn("ArtifactSchedules.list")(function* (
  lineageId?: ArtifactLineageId,
) {
  const records = yield* AutomationRecords;
  return records
    .snapshot()
    .artifactSchedules.filter((item) => lineageId === undefined || item.lineageId === lineageId);
});

export const areArtifactSchedulesPaused = Effect.fn("ArtifactSchedules.isPaused")(function* (
  lineageId: ArtifactLineageId,
) {
  return (yield* AutomationRecords).snapshot().pausedArtifactIds.includes(lineageId);
});

export const removeArtifactSchedule = Effect.fn("ArtifactSchedules.remove")(
  function* (identity: ArtifactScheduleIdentity) {
    const records = yield* AutomationRecords;
    return yield* records.transact((ledger) =>
      Effect.succeed({
        ledger: {
          ...ledger,
          artifactSchedules: ledger.artifactSchedules.filter((item) => !matches(item, identity)),
        },
        result: undefined,
      }),
    );
  },
  (effect, identity) => effect.pipe(Effect.tap(() => invalidateExecution(identity.lineageId))),
);

/** Delete schedules before deleting the artifact's data. */
export const removeArtifactSchedules = Effect.fn("ArtifactSchedules.removeArtifact")(
  function* (lineageId: ArtifactLineageId) {
    const records = yield* AutomationRecords;
    yield* records.transact((ledger) =>
      Effect.succeed({
        ledger: {
          ...ledger,
          artifactSchedules: ledger.artifactSchedules.filter(
            (item) => item.lineageId !== lineageId,
          ),
          pausedArtifactIds: ledger.pausedArtifactIds.filter((id) => id !== lineageId),
        },
        result: undefined,
      }),
    );
  },
  (effect, lineageId) => effect.pipe(Effect.tap(() => invalidateExecution(lineageId))),
);

/** Explicit stop/resume only. UI mounts and ordinary invocations must never call resume. */
export const setArtifactSchedulesPaused = Effect.fn("ArtifactSchedules.setPaused")(
  function* (lineageId: ArtifactLineageId, paused: boolean) {
    const records = yield* AutomationRecords;
    yield* records.transact((ledger) =>
      Effect.succeed({
        ledger: {
          ...ledger,
          artifactSchedules: ledger.artifactSchedules.map((item) =>
            item.lineageId === lineageId ? { ...item, paused } : item,
          ),
          pausedArtifactIds: [
            ...ledger.pausedArtifactIds.filter((id) => id !== lineageId),
            ...(paused ? [lineageId] : []),
          ],
        },
        result: undefined,
      }),
    );
  },
  (effect, lineageId) => effect.pipe(Effect.tap(() => invalidateExecution(lineageId))),
);

/**
 * Called by the existing backend automation worker, not by a renderer timer.
 * Advance accepted work past now before invoking outside the storage transaction:
 * a restart does one catch-up refresh, never a replay of every missed interval.
 * Callback admission captures the current source revision in ArtifactRuntime.
 */
export const runArtifactSchedulePass = Effect.fn("ArtifactSchedules.runPass")(function* <A, E, R>(
  invoke: (schedule: ArtifactSchedule) => Effect.Effect<A, E, R>,
) {
  const nowText = DateTime.formatIso(yield* DateTime.now);
  const records = yield* AutomationRecords;
  const due = records
    .snapshot()
    .artifactSchedules.filter(
      (item) =>
        !item.paused && item.nextScheduledAt !== undefined && item.nextScheduledAt <= nowText,
    );
  for (const candidate of due) {
    const admittedAt = yield* DateTime.now;
    const schedule = yield* records.transact((ledger) =>
      Effect.gen(function* () {
        // Earlier handlers may pause, remove or reconfigure later candidates. Only
        // consume an occurrence when this individual handler is actually admitted.
        const current = ledger.artifactSchedules.find((item) => matches(item, candidate));
        if (
          !current ||
          current.paused ||
          current.nextScheduledAt === undefined ||
          current.nextScheduledAt > DateTime.formatIso(admittedAt)
        )
          return { ledger, result: undefined };
        const next = yield* nextScheduledAt(current.schedule, DateTime.toEpochMillis(admittedAt));
        const advanced: ArtifactSchedule = Struct.omit(current, ["nextScheduledAt"]);
        if (next !== undefined) Object.assign(advanced, { nextScheduledAt: next });
        return {
          ledger: {
            ...ledger,
            artifactSchedules: ledger.artifactSchedules.map((item) =>
              matches(item, current) ? advanced : item,
            ),
          },
          result: current,
        };
      }),
    );
    if (!schedule) continue;
    yield* invalidateExecution(schedule.lineageId);
    const lastRunAt = DateTime.formatIso(yield* DateTime.now);
    const outcome = yield* invoke(schedule).pipe(Effect.result);
    const receipt =
      outcome._tag === "Success"
        ? { lastRunAt, lastOutcome: "completed" as const }
        : {
            lastRunAt,
            lastOutcome: "failed" as const,
            lastError: (outcome.failure instanceof Error
              ? outcome.failure.message
              : String(outcome.failure)
            ).slice(0, 4_096),
          };
    if (outcome._tag === "Failure")
      yield* Effect.logError("Scheduled artifact handler failed", outcome.failure);
    yield* records.transact((ledger) =>
      Effect.succeed({
        ledger: {
          ...ledger,
          artifactSchedules: ledger.artifactSchedules.map((item) =>
            matches(item, schedule) ? { ...Struct.omit(item, ["lastError"]), ...receipt } : item,
          ),
        },
        result: undefined,
      }),
    );
    yield* invalidateExecution(schedule.lineageId);
  }
});
