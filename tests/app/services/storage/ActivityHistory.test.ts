import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { activityPageSize } from "../../../../src/contracts/application/activity-history";
import { listActivity } from "../../../../src/domain/application/activityHistory";
import { AutomationRecords } from "../../../../src/services/automations/AutomationRecords";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import {
  ActivityHistory,
  makeActivityHistoryLive,
} from "../../../../src/services/storage/ActivityHistory";

const directory = Effect.acquireRelease(
  Effect.promise(() => mkdtemp(join(tmpdir(), "cake-activity-"))),
  (path) => Effect.promise(() => rm(path, { force: true, recursive: true })),
);

it.effect(
  "reopens the ordered history, retaining notices with no toast subscriber and deduplicating producer retries",
  () =>
    Effect.gen(function* () {
      const path = yield* directory;
      yield* Effect.gen(function* () {
        const history = yield* ActivityHistory;
        const clientEvents = yield* ClientEvents;
        // There is no renderer to enqueue the toast (or an OS notification).
        expect(
          clientEvents.sendTo(1, {
            type: "notification",
            title: "Required attention",
            message: "Retry in Cake",
            tone: "warning",
          }),
        ).toBe(false);
        history.record({
          id: "merge:op",
          at: "2026-02-01T01:00:00.000Z",
          kind: "merge",
          title: "Merged",
          sessionId: "session-a",
          projectPath: "/app",
        });
        history.record({
          id: "resolution:op",
          at: "2026-02-01T01:00:01.000Z",
          kind: "resolution",
          title: "Resolved",
          sessionId: "session-a",
          projectPath: "/app",
        });
        clientEvents.broadcast({ type: "window-blurred" });
      }).pipe(
        Effect.provide(ClientEventsLive.pipe(Layer.provideMerge(makeActivityHistoryLive(path)))),
      );

      yield* Effect.gen(function* () {
        const history = yield* ActivityHistory;
        history.record({
          id: "merge:op",
          kind: "merge",
          title: "Replayed merge",
          projectPath: "/app",
        });
        expect(
          (yield* history.list({ projectPath: "/app" })).map(({ kind, sessionId }) => ({
            kind,
            sessionId,
          })),
        ).toEqual([
          { kind: "resolution", sessionId: "session-a" },
          { kind: "merge", sessionId: "session-a" },
        ]);
        expect(yield* history.list({ projectPath: "/app", kind: "merge" })).toMatchObject([
          { title: "Merged" },
        ]);
        expect(yield* history.list({ projectPath: null })).toMatchObject([
          {
            kind: "notification",
            title: "Required attention",
            detail: "Retry in Cake",
            tone: "warning",
          },
        ]);
      }).pipe(Effect.provide(makeActivityHistoryLive(path)));
    }),
);

it.effect(
  "pages matching events at tied timestamps without overlap, even if a newer event arrives",
  () =>
    Effect.gen(function* () {
      const path = yield* directory;
      yield* Effect.gen(function* () {
        const history = yield* ActivityHistory;
        const at = "2026-02-01T01:00:00.000Z";
        for (let index = 0; index < activityPageSize + 3; index++) {
          history.record({
            id: `matching:${String(index).padStart(2, "0")}`,
            at,
            kind: "merge",
            title: "Merged",
            projectPath: "/app",
          });
          history.record({
            id: `other:${index}`,
            at,
            kind: "merge",
            title: "Merged",
            projectPath: "/other",
          });
        }
        const query = { kind: "merge", projectPath: "/app" } as const;
        const first = yield* listActivity(query);
        expect(first.entries).toHaveLength(activityPageSize);
        expect(first.next).toBeDefined();
        if (!first.next) return;
        history.record({
          id: "new",
          at: "2026-02-02T01:00:00.000Z",
          kind: "merge",
          title: "New merge",
          projectPath: "/app",
        });
        const older = yield* listActivity({ ...query, before: first.next });
        expect(older.entries.map((entry) => entry.id)).toEqual([
          "matching:02",
          "matching:01",
          "matching:00",
        ]);
        expect(older.next).toBeUndefined();
      }).pipe(
        Effect.provide(
          Layer.merge(
            makeActivityHistoryLive(path),
            Layer.mock(AutomationRecords, {
              snapshot: () => {
                throw new Error("Merge-only queries must not read automation history");
              },
            }),
          ),
        ),
      );
    }),
);
