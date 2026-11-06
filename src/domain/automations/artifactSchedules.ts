import { DateTime, Effect, Schema, Struct } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import {
  type ArtifactSchedule,
  ArtifactScheduleConfigureInput,
  type ArtifactScheduleIdentity,
} from "../../contracts/artifacts/artifact-schedules";
import { AutomationRecords } from "../../services/automations/AutomationRecords";
import { automationError, nextScheduledAt } from "./automationDefinitions";

const matches = (item: ArtifactSchedule, identity: ArtifactScheduleIdentity) =>
  item.lineageId === identity.lineageId && item.name === identity.name;

/** Reconfiguration replaces one named schedule; opening another view never creates a new identity. */
export const configureArtifactSchedule = Effect.fn("ArtifactSchedules.configure")(function* (
  input: ArtifactScheduleConfigureInput,
) {
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
});

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

export const removeArtifactSchedule = Effect.fn("ArtifactSchedules.remove")(function* (
  identity: ArtifactScheduleIdentity,
) {
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
});

/** Delete schedules before deleting the artifact's data. */
export const removeArtifactSchedules = Effect.fn("ArtifactSchedules.removeArtifact")(function* (
  lineageId: ArtifactLineageId,
) {
  const records = yield* AutomationRecords;
  yield* records.transact((ledger) =>
    Effect.succeed({
      ledger: {
        ...ledger,
        artifactSchedules: ledger.artifactSchedules.filter((item) => item.lineageId !== lineageId),
        pausedArtifactIds: ledger.pausedArtifactIds.filter((id) => id !== lineageId),
      },
      result: undefined,
    }),
  );
});

/** Explicit stop/resume only. UI mounts and ordinary invocations must never call resume. */
export const setArtifactSchedulesPaused = Effect.fn("ArtifactSchedules.setPaused")(function* (
  lineageId: ArtifactLineageId,
  paused: boolean,
) {
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
});

/**
 * Called by the existing backend automation worker, not by a renderer timer.
 * Advance accepted work past now before invoking outside the storage transaction:
 * a restart does one catch-up refresh, never a replay of every missed interval.
 * Callback admission captures the current source revision in ArtifactRuntime.
 */
export const runArtifactSchedulePass = Effect.fn("ArtifactSchedules.runPass")(function* <A, E, R>(
  invoke: (schedule: ArtifactSchedule) => Effect.Effect<A, E, R>,
) {
  const now = yield* DateTime.now;
  const nowText = DateTime.formatIso(now);
  const records = yield* AutomationRecords;
  if (
    !records
      .snapshot()
      .artifactSchedules.some(
        (item) =>
          !item.paused && item.nextScheduledAt !== undefined && item.nextScheduledAt <= nowText,
      )
  )
    return;
  const due = yield* records.transact((ledger) =>
    Effect.gen(function* () {
      const due: ArtifactSchedule[] = [];
      const schedules: ArtifactSchedule[] = [];
      for (const schedule of ledger.artifactSchedules) {
        if (
          schedule.paused ||
          schedule.nextScheduledAt === undefined ||
          schedule.nextScheduledAt > nowText
        ) {
          schedules.push(schedule);
          continue;
        }
        due.push(schedule);
        const next = yield* nextScheduledAt(schedule.schedule, DateTime.toEpochMillis(now));
        const advanced: ArtifactSchedule = Struct.omit(schedule, ["nextScheduledAt"]);
        if (next !== undefined) Object.assign(advanced, { nextScheduledAt: next });
        schedules.push(advanced);
      }
      return { ledger: { ...ledger, artifactSchedules: schedules }, result: due };
    }),
  );
  for (const schedule of due) {
    // Stop/remove may have happened while an earlier artifact's handler ran.
    const current = records.snapshot().artifactSchedules.find((item) => matches(item, schedule));
    if (!current || current.paused) continue;
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
  }
});
