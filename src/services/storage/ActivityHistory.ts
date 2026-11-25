import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";
import {
  ActivityEntry,
  ActivityHistoryError,
  activityPageSize,
  type ActivityQuery,
} from "../../contracts/application/activity-history";

type NewEntry = Omit<ActivityEntry, "id" | "at"> & Partial<Pick<ActivityEntry, "id" | "at">>;

export class ActivityHistory extends Context.Service<
  ActivityHistory,
  {
    /** Native callbacks cannot await. One short insert commits before any live delivery. */
    readonly record: (entry: NewEntry) => void;
    readonly list: (
      query: ActivityQuery,
    ) => Effect.Effect<readonly ActivityEntry[], ActivityHistoryError>;
  }
>()("cake/services/storage/ActivityHistory") {}

export const recordActivity = Effect.fn("ActivityHistory.record")(function* (entry: NewEntry) {
  const history = yield* Effect.serviceOption(ActivityHistory);
  if (Option.isSome(history)) history.value.record(entry);
});

const unavailable = (cause: unknown) =>
  new ActivityHistoryError({
    message: `Activity history is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const validateEntry = Schema.decodeUnknownResult(ActivityEntry);

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      entry: Schema.fromJsonString(ActivityEntry),
    }),
  ),
);

export const makeActivityHistoryLive = (stateDirectory: string) =>
  Layer.effect(
    ActivityHistory,
    Effect.gen(function* () {
      const opened = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: async () => {
            await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
            const db = new DatabaseSync(join(stateDirectory, "activity.sqlite"));
            try {
              db.exec(`CREATE TABLE IF NOT EXISTS activity (
              id TEXT PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, project_path TEXT, entry TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS activity_recent ON activity(at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS activity_project_recent ON activity(project_path, at DESC, id DESC);
            CREATE INDEX IF NOT EXISTS activity_kind_recent ON activity(kind, at DESC, id DESC);`);
              return db;
            } catch (error) {
              db.close();
              throw error;
            }
          },
          catch: unavailable,
        }).pipe(Effect.result),
        (result) =>
          Effect.sync(() => {
            if (result._tag === "Success") result.success.close();
          }),
      );
      if (opened._tag === "Failure") {
        yield* Effect.logWarning(opened.failure.message);
        return ActivityHistory.of({ record: () => {}, list: () => Effect.fail(opened.failure) });
      }
      const db = opened.success;
      const insert = db.prepare("INSERT OR IGNORE INTO activity VALUES (?, ?, ?, ?, ?)");
      const record = (input: NewEntry) => {
        const entry = {
          ...input,
          id: input.id ?? crypto.randomUUID(),
          at: input.at ?? new Date().toISOString(),
          title: input.title.slice(0, 512),
        };
        if (input.detail !== undefined)
          Object.assign(entry, { detail: input.detail.slice(0, 4_096) });
        if (Result.isFailure(validateEntry(entry))) {
          console.warn("[cake] Could not record invalid Activity entry", entry.kind);
          return;
        }
        try {
          insert.run(
            entry.id,
            entry.at,
            entry.kind,
            entry.projectPath ?? null,
            JSON.stringify(entry),
          );
        } catch (error) {
          // Activity must never change the result of a lifecycle action or prevent live delivery.
          console.warn("[cake] Could not record Activity", error);
        }
      };
      const list = Effect.fn("ActivityHistory.list")(function* (query: ActivityQuery) {
        const conditions: string[] = [];
        const parameters: string[] = [];
        if (query.projectPath === null) conditions.push("project_path IS NULL");
        else if (query.projectPath !== undefined) {
          conditions.push("project_path = ?");
          parameters.push(query.projectPath);
        }
        if (query.kind) {
          conditions.push("kind = ?");
          parameters.push(query.kind);
        }
        if (query.before) {
          conditions.push("(at, id) < (?, ?)");
          parameters.push(query.before.at, query.before.id);
        }
        const rows = yield* Effect.try({
          try: () =>
            db
              .prepare(`SELECT entry FROM activity ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
          ORDER BY at DESC, id DESC LIMIT ?`)
              .all(...parameters, activityPageSize + 1),
          catch: unavailable,
        });
        return (yield* decodeRows(rows).pipe(Effect.mapError(unavailable))).map(
          ({ entry }) => entry,
        );
      });
      return ActivityHistory.of({ record, list });
    }),
  );
