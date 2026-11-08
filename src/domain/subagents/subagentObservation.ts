import { Cache, Effect, Schema, Stream, SubscriptionRef } from "effect";
import type { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import {
  type SubagentActivity,
  SubagentMetadata,
  type SubagentUpdate,
} from "../../contracts/subagents/subagent-data";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import {
  SubagentCoordinator,
  activityOf,
  type SubagentCoordinatorState,
} from "../../services/subagents/SubagentCoordinator";
import type { SubagentHistory } from "../../services/storage/SubagentStorage";
import { jsonValue, boundedError } from "./subagentCompletion";

const historyActivity = Effect.fn("Subagents.historyActivity")(function* (record: SubagentHistory) {
  const sessions = yield* CakeSessionRuntimes;
  const preview = yield* sessions
    .inspect(
      {
        workingDirectory: record.workingDirectory,
        sessionDirectory: record.sessionDirectory,
        sessionId: record.privateSessionId,
      },
      { includeParts: true },
    )
    .pipe(Effect.result);
  const activity: SubagentActivity = {
    parentSessionId: record.parentSessionId,
    anchorPartId: record.anchorPartId,
    handleId: record.handleId,
    revision: 0,
    task: record.task,
    status: record.status,
    resolvedModel: record.resolvedModel,
    fastMode: record.fastMode,
    streaming: false,
    released: true,
    resolved: true,
    parts: preview._tag === "Success" ? preview.success.parts.map(jsonValue) : [],
  };
  if (record.projectPath) Object.assign(activity, { projectPath: record.projectPath });
  if (record.failurePhase) Object.assign(activity, { failurePhase: record.failurePhase });
  if (preview._tag === "Failure")
    Object.assign(activity, {
      error: boundedError(
        `The saved subagent conversation could not be loaded: ${preview.failure.message}. Its handle mapping is retained; restore the Pi transcript to read it.`,
      ),
    });
  else if (record.error !== undefined)
    Object.assign(activity, { error: boundedError(record.error) });
  return activity;
});

const parentActivities = (state: SubagentCoordinatorState, parentSessionId: string) =>
  [...state.handles.values()]
    .filter((handle) => handle.parentSessionId === parentSessionId)
    .map(activityOf);

const backgroundActive = (activities: ReadonlyArray<SubagentActivity>) =>
  activities.some((activity) => activity.status === "queued" || activity.status === "running");

const sameMetadata = Schema.toEquivalence(Schema.Array(SubagentMetadata));

/** Ownership/activity catalog only: no Pi hydration or historical transcript inspection. */
export const observeMetadata = Effect.fn("Subagents.observeMetadata")(function* (
  parentSessionId: string,
) {
  const coordinator = yield* SubagentCoordinator;
  return SubscriptionRef.changes(coordinator.state).pipe(
    Stream.mapEffect((state) =>
      coordinator.storage.history.list().pipe(
        Effect.map((history): readonly SubagentMetadata[] => [
          ...[...state.handles.values()]
            .filter((handle) => handle.parentSessionId === parentSessionId)
            .map((handle) => ({
              parentSessionId: handle.parentSessionId,
              handleId: handle.handleId,
              anchorPartId: handle.anchorPartId,
              task: handle.task,
              ...(handle.projectPath ? { projectPath: handle.projectPath } : null),
              status: handle.status,
              streaming: handle.streaming,
              released: false,
              resolved: false,
            })),
          ...history
            .filter(
              (record) =>
                record.parentSessionId === parentSessionId && !state.handles.has(record.handleId),
            )
            .map((record) => ({
              parentSessionId: record.parentSessionId,
              handleId: record.handleId,
              anchorPartId: record.anchorPartId,
              task: record.task,
              ...(record.projectPath ? { projectPath: record.projectPath } : null),
              status: record.status,
              streaming: false,
              released: true,
              resolved: true,
            })),
        ]),
      ),
    ),
    Stream.changesWith(sameMetadata),
  );
});

export const observe = Effect.fn("Subagents.observe")(function* (parentSessionId: string) {
  const coordinator = yield* SubagentCoordinator;
  return Stream.unwrap(
    Effect.gen(function* () {
      // A scoped projection cache only: Pi remains the transcript authority and no runtime is acquired.
      const history = yield* Cache.make({ capacity: 1000, lookup: historyActivity });
      const handles = (yield* SubscriptionRef.get(coordinator.state)).handles.values();
      yield* Effect.forEach(
        [...handles].filter(
          (handle) => handle.parentSessionId === parentSessionId && handle.hydrate,
        ),
        (handle) =>
          (handle.hydrate ?? Effect.void).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Worker transcript needs attention", handle.handleId, error),
            ),
          ),
        { concurrency: 4, discard: true },
      ).pipe(Effect.forkScoped);
      return Stream.suspend(() => {
        let previous: ReadonlyMap<SubagentHandleId, SubagentActivity> | undefined;
        let previousBackground = false;
        return SubscriptionRef.changes(coordinator.state).pipe(
          Stream.mapEffect((state) =>
            Effect.gen(function* () {
              const live = parentActivities(state, parentSessionId);
              const released = (yield* coordinator.storage.history.list()).filter(
                (record) =>
                  record.parentSessionId === parentSessionId && !state.handles.has(record.handleId),
              );
              const activities = [
                ...live,
                ...(yield* Effect.forEach(released, (record) => Cache.get(history, record), {
                  concurrency: 4,
                })),
              ];
              return { state, activities };
            }),
          ),
          Stream.flatMap(({ state, activities }) => {
            const current = new Map(
              activities.map((activity) => [activity.handleId, activity] as const),
            );
            const background = backgroundActive(activities);
            if (!previous) {
              previous = current;
              previousBackground = background;
              return Stream.succeed<SubagentUpdate>({
                _tag: "Snapshot",
                revision: state.revision,
                parentSessionId,
                activities,
                backgroundActive: background,
              });
            }
            const updates: SubagentUpdate[] = [];
            for (const activity of activities) {
              if (
                previous.get(activity.handleId)?.revision !== activity.revision ||
                previous.get(activity.handleId)?.released !== activity.released
              )
                updates.push({
                  _tag: "Activity",
                  revision: state.revision,
                  parentSessionId,
                  activity,
                });
            }
            for (const handleId of previous.keys()) {
              if (!current.has(handleId))
                updates.push({
                  _tag: "Removed",
                  revision: state.revision,
                  parentSessionId,
                  handleId,
                });
            }
            if (background !== previousBackground)
              updates.push({
                _tag: "Background",
                revision: state.revision,
                parentSessionId,
                active: background,
              });
            previous = current;
            previousBackground = background;
            return Stream.fromIterable(updates);
          }),
        );
      });
    }),
  );
});
