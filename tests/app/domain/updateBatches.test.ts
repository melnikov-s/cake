import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe } from "vitest";
import * as batches from "../../../src/domain/session-families/updateBatches";
import * as chats from "../../../src/domain/conversations/sessionChats";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  UPDATE_BATCH_CACHE_MARGIN_MS,
  UPDATE_BATCH_WINDOW_MS,
  splitUpdateBatchReminder,
  updateBatchDueAt,
} from "../../../src/contracts/conversations/update-batch";
import type { SessionContextMetadata } from "../../../src/contracts/conversations/session-context-metadata";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryRecord,
} from "../../../src/services/storage/RuntimeRecoveryStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { PiModels } from "../../../src/services/pi/PiModels";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { splitContextReminders } from "../../../src/services/pi/runtime/session-context-reminders";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { messageBoardHarness } from "../helpers/messageBoardHarness";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import {
  fakeRuntime,
  snapshot,
  makeRuntimeRecoveryStorageTestLayer,
} from "../helpers/piRuntimeFixture";

const START = Date.parse("2026-03-01T12:00:00.000Z");
const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};

/** An Anthropic 5-minute cache written `ageMs` before START. */
const warmCache = (ageMs: number): SessionContextMetadata => ({
  estimatedTokens: 1000,
  lastModelActivityAt: new Date(START - ageMs).toISOString(),
  cacheObservation: {
    provider: "anthropic",
    observedAt: new Date(START - ageMs).toISOString(),
    readTokens: 0,
    writeTokens: 100,
    write1hTokens: 0,
  },
});

const fixture = Effect.fn("UpdateBatchTest.fixture")(function* (
  settings: {
    busy?: boolean;
    hold?: boolean;
    cache?: SessionContextMetadata;
    familyFiles?: Map<string, string>;
    records?: ReadonlyArray<RuntimeRecoveryRecord>;
  } = {},
) {
  const family = familyStorageHarness(settings.familyFiles);
  const board = messageBoardHarness();
  const release = yield* Deferred.make<void>();
  const admitted: Array<{
    text: string;
    lane: string;
    internal: RuntimeRecoveryRecord["inputs"][number]["internal"];
  }> = [];
  let busy = settings.busy ?? false;
  const core = yield* Layer.build(
    Layer.mergeAll(
      WorkflowTestLive,
      makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
      family.layer,
      board.layer,
      SessionCatalogChanges.layer,
      Layer.mock(ApplicationState, {
        snapshot: () => defaultApplicationState(),
        current: () => Effect.succeed(defaultApplicationState()),
      }),
      Layer.mock(PiModels, { resolve: (model) => Effect.succeed(model) }),
      Layer.mock(ManagedWorktrees, {
        records: () => Effect.succeed([]),
        awaitSetup: () => Effect.void,
      }),
      Layer.mock(SessionArchiveStorage, {
        locate: () => Effect.succeed("active" as const),
        resolvedProjectEntry: () => Effect.succeed(undefined),
        resolvedProjects: () => Stream.empty,
      }),
      makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: (target) =>
          Effect.succeed({
            workspacePath: target.workingDirectory,
            sessionId: target.sessionId ?? "parent",
            sessionFile: "/cake/sessions/parent.jsonl",
            parts: [],
            ...(settings.cache ? { contextMetadata: settings.cache } : null),
          }),
        changelog: () => Effect.succeed(""),
        createRuntime: (setup) =>
          Effect.succeed({
            ...fakeRuntime(setup, () => undefined),
            sessionId: setup.sessionId ?? "parent",
            get streaming() {
              return busy;
            },
            snapshot: async () => ({
              ...snapshot,
              sessionId: setup.sessionId ?? "parent",
              streaming: busy,
            }),
            prompt: async (
              text,
              lane,
              _attachments,
              _markdown,
              _turnId,
              _presentation,
              _title,
              _response,
              internal,
            ) => {
              admitted.push({ text, lane, internal });
              if (settings.hold) await Effect.runPromise(Deferred.await(release));
            },
          }),
      }).pipe(Layer.provideMerge(makeRuntimeRecoveryStorageTestLayer(settings.records))),
    ),
  );
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(core));
  const storage = Context.get(core, SessionFamilyStorage);
  yield* provide(
    Effect.gen(function* () {
      if (!(yield* storage.familyForMember("parent")))
        yield* storage.addChild({
          familyId: "family",
          parentSessionId: "parent",
          parentWorkingDirectory: "/project",
          childSessionId: "child",
          childWorkingDirectory: "/project",
          requestId: "child",
          projectPath: "/project",
          createdAt: "2026-01-01",
          resultDelivery: "notification",
        });
    }),
  );
  const notice = (label: string) => {
    const id = crypto.randomUUID();
    return provide(
      storage.deferPassiveNotice({
        id,
        recipientSessionId: "parent",
        text: label,
        crossSession: {
          version: 1,
          messageId: id,
          threadId: id,
          sequence: 1,
          expectsResponse: false,
          resultDelivery: "ignore",
          sender: { sessionId: "other", title: "Other session", kind: "project-session" },
        },
      }),
    ).pipe(Effect.as(id));
  };
  /** A notification-mode child result settled into the parent's digest inbox. */
  const result = (summary: string) => {
    const turnId = crypto.randomUUID();
    return provide(
      Effect.gen(function* () {
        yield* storage.recordTurn({
          sessionId: "child",
          senderSessionId: "parent",
          turnId,
          requestMessageId: turnId,
          threadId: turnId,
          reported: false,
          outcome: "complete",
          resultDelivery: "notification",
        });
        yield* storage.digestNotice(turnId, {
          id: turnId,
          coordinatorSessionId: "parent",
          sessionId: "child",
          title: "Child task",
          status: "completed",
          summary,
          reportedAt: new Date(START).toISOString(),
        });
      }),
    ).pipe(Effect.as(turnId));
  };
  const pass = () => provide(batches.runPass());
  const state = () => provide(storage.state());
  const batch = () =>
    state().pipe(
      Effect.map((document) =>
        document.updateBatches?.find((item) => item.recipientSessionId === "parent"),
      ),
    );
  const userMessage = (text: string) =>
    provide(
      Effect.scoped(
        Effect.gen(function* () {
          yield* (yield* CakeSessionRuntimes).acquire(
            yield* acquireOptions({ location, sessionId: "parent", newSession: false }),
          );
          yield* chats.deliver(
            { sessionId: "parent", text, attachments: [], renderUserMessageAsMarkdown: false },
            "prompt",
          );
        }),
      ),
    );
  const records = () =>
    provide(
      Effect.gen(function* () {
        return yield* (yield* RuntimeRecoveryStorage).list();
      }),
    );
  return {
    provide,
    storage,
    notice,
    result,
    pass,
    state,
    batch,
    userMessage,
    records,
    admitted,
    release,
    familyFiles: family.files,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
});

const advance = (ms: number) => TestClock.adjust(`${ms} millis`);

describe("updateBatchDueAt", () => {
  it("uses the 5-minute window for unknown or expired caches", () => {
    assert.equal(updateBatchDueAt(START, undefined, START), START + UPDATE_BATCH_WINDOW_MS);
    assert.equal(updateBatchDueAt(START, START - 1, START), START + UPDATE_BATCH_WINDOW_MS);
  });
  it("delivers shortly before an earlier cache expiry", () => {
    const expiry = START + 2 * 60_000;
    assert.equal(updateBatchDueAt(START, expiry, START), expiry - UPDATE_BATCH_CACHE_MARGIN_MS);
  });
  it("keeps the window when the cache outlives it", () => {
    assert.equal(
      updateBatchDueAt(START, START + 60 * 60_000, START),
      START + UPDATE_BATCH_WINDOW_MS,
    );
  });
  it("delivers immediately when the cache expires within the margin", () => {
    assert.equal(updateBatchDueAt(START, START + 10_000, START), START);
  });
});

describe("timed batch delivery", () => {
  it.effect("opens one timer on the first item and delivers everything once after 5 minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture();
      assert.equal(yield* f.batch(), undefined);
      yield* f.notice("First FYI");
      yield* f.pass();
      const opened = yield* f.batch();
      assert.equal(opened?.openedAt, new Date(START).toISOString());
      assert.equal(opened?.dueAt, new Date(START + UPDATE_BATCH_WINDOW_MS).toISOString());

      // Later items join the open batch without moving its deadline.
      yield* advance(60_000);
      yield* f.result("Tests pass");
      yield* f.notice("Second FYI");
      yield* f.pass();
      assert.equal((yield* f.batch())?.dueAt, opened?.dueAt);
      yield* advance(UPDATE_BATCH_WINDOW_MS - 60_000 - 1);
      yield* f.pass();
      assert.equal(f.admitted.length, 0);

      yield* advance(1);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
      const turn = f.admitted[0]!;
      assert.equal(turn.lane, "follow-up");
      assert.equal(turn.internal?._tag, "UpdateBatch");
      assert.deepEqual(
        turn.internal?._tag === "UpdateBatch" ? turn.internal.notices.map((n) => n.text) : [],
        ["First FYI", "Second FYI"],
      );
      assert.match(turn.text, /Cake session updates/);
      assert.match(turn.text, /Tests pass/);
      assert.match(turn.text, /Cake batched updates/);
      // The transcript shows Cake context only, no fabricated user text.
      const shown = splitContextReminders(turn.text.split("\n\nCake passive updates")[0]!);
      assert.equal(shown.text, "");
      assert.deepEqual(
        shown.reminders.map((item) => item.title),
        ["Cake · session updates", "Cake · batched updates"],
      );

      const settled = yield* f.state();
      assert.equal(settled.updateBatches?.length ?? 0, 0);
      assert.deepEqual(settled.coordinatorDigest, []);
      assert.ok(settled.passiveNotices?.every((item) => item.delivered));
      // Delivered once: later passes do nothing.
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
    }),
  );

  it.effect("fires shortly before a warm cache expires when that comes first", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      // Written 3 minutes ago: the 5-minute cache expires in 2 minutes.
      const f = yield* fixture({ cache: warmCache(3 * 60_000) });
      yield* f.notice("FYI");
      yield* f.pass();
      const due = START + 2 * 60_000 - UPDATE_BATCH_CACHE_MARGIN_MS;
      assert.equal((yield* f.batch())?.dueAt, new Date(due).toISOString());
      yield* advance(due - START - 1);
      yield* f.pass();
      assert.equal(f.admitted.length, 0);
      yield* advance(1);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
    }),
  );

  it.effect("falls back to the 5-minute window when the cache already expired", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture({ cache: warmCache(10 * 60_000) });
      yield* f.notice("FYI");
      yield* f.pass();
      assert.equal(
        (yield* f.batch())?.dueAt,
        new Date(START + UPDATE_BATCH_WINDOW_MS).toISOString(),
      );
    }),
  );

  it.effect("a user message carries the batch and cancels its timer", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture();
      yield* f.notice("FYI");
      yield* f.result("Ready for review");
      yield* f.pass();
      assert.ok(yield* f.batch());
      yield* advance(60_000);
      yield* f.userMessage("What changed?");
      assert.equal(f.admitted.length, 1);
      assert.match(f.admitted[0]!.text, /What changed\?/);
      assert.match(f.admitted[0]!.text, /Ready for review/);
      assert.equal(f.admitted[0]!.internal?._tag, "UserWithReminders");
      assert.equal(yield* f.batch(), undefined);
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);

      // A later item starts a fresh window rather than reusing the cancelled deadline.
      yield* f.notice("Later FYI");
      yield* f.pass();
      const now = START + 60_000 + UPDATE_BATCH_WINDOW_MS;
      assert.equal((yield* f.batch())?.openedAt, new Date(now).toISOString());
    }),
  );

  it.effect("waits behind active work, absorbs later items and never steers", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture({ busy: true });
      yield* f.notice("Before");
      yield* f.pass();
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 0);
      yield* f.notice("While busy");
      yield* advance(60_000);
      yield* f.pass();
      assert.equal(f.admitted.length, 0);
      f.setBusy(false);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
      assert.equal(f.admitted[0]!.lane, "follow-up");
      const internal = f.admitted[0]!.internal;
      assert.deepEqual(
        internal?._tag === "UpdateBatch" ? internal.notices.map((n) => n.text) : [],
        ["Before", "While busy"],
      );
    }),
  );

  it.effect("items arriving during an in-flight batch open the next batch", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture({ hold: true });
      yield* f.notice("First");
      yield* f.pass();
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
      // The batch turn is still running.
      yield* f.notice("During");
      yield* f.pass();
      const next = yield* f.batch();
      assert.equal(next?.turnId, undefined);
      assert.equal(next?.dueAt, new Date(START + 2 * UPDATE_BATCH_WINDOW_MS).toISOString());
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 1, "never runs beside the in-flight batch turn");
      yield* Deferred.succeed(f.release, undefined);
      while ((yield* f.records()).some((record) => record.inputs.length)) yield* Effect.yieldNow;
      yield* f.pass();
      assert.equal(f.admitted.length, 2);
      const internal = f.admitted[1]!.internal;
      assert.deepEqual(
        internal?._tag === "UpdateBatch" ? internal.notices.map((n) => n.text) : [],
        ["During"],
      );
    }),
  );

  it.effect("an open timer survives restart and keeps its original deadline", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture();
      yield* f.notice("FYI");
      yield* f.pass();
      const opened = yield* f.batch();
      yield* advance(4 * 60_000);
      const restarted = yield* fixture({ familyFiles: f.familyFiles });
      yield* restarted.pass();
      assert.deepEqual(yield* restarted.batch(), opened);
      assert.equal(restarted.admitted.length, 0);
      yield* advance(60_000);
      yield* restarted.pass();
      assert.equal(restarted.admitted.length, 1);
    }),
  );

  it.effect("re-derives a missing timer for items retained before batching existed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture();
      yield* f.notice("Old FYI");
      yield* f.pass();
      yield* f.provide(f.storage.closeUpdateBatch("parent"));
      yield* advance(10 * 60_000);
      yield* f.pass();
      assert.equal((yield* f.batch())?.openedAt, new Date(START + 10 * 60_000).toISOString());
    }),
  );

  it.effect("a restart after admission reconciles the batch instead of sending it twice", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture({ hold: true });
      const id = yield* f.notice("FYI");
      yield* f.result("Done");
      yield* f.pass();
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
      const turnId = (yield* f.records())[0]?.inputs[0]?.turnId;
      assert.ok(turnId);
      // Simulate a crash after Pi journaled the input but before Cake settled the batch.
      yield* f.provide(
        Effect.gen(function* () {
          yield* f.storage.saveUpdateBatch({
            recipientSessionId: "parent",
            openedAt: new Date(START).toISOString(),
            dueAt: new Date(START).toISOString(),
            turnId,
          });
          yield* f.storage.markPassiveNoticeAdmission([id], turnId);
        }),
      );
      const restarted = yield* fixture({
        familyFiles: f.familyFiles,
        records: yield* f.records(),
        busy: false,
      });
      yield* restarted.pass();
      assert.equal(restarted.admitted.length, 0);
      const state = yield* restarted.state();
      assert.equal(state.updateBatches?.length ?? 0, 0);
      assert.ok(state.passiveNotices?.every((item) => item.delivered));
      assert.deepEqual(state.coordinatorDigest, []);
    }),
  );

  it.effect("quiet worker reports join the batch once and stay pending until acknowledged", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture();
      yield* f.provide(
        f.storage.deferReferenceNotice({
          id: "report-1",
          recipientSessionId: "parent",
          text: "Worker finished the audit.",
        }),
      );
      yield* f.pass();
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 1);
      assert.match(f.admitted[0]!.text, /Worker finished the audit/);
      const state = yield* f.state();
      assert.equal(state.deferredReferences?.[0]?.admissions, 1);
      // Admitted once: the retained obligation does not rearm another timer.
      yield* f.pass();
      assert.equal(yield* f.batch(), undefined);
    }),
  );

  it.effect("an explicitly stopped conversation is not woken; its batch waits for the user", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      const f = yield* fixture({
        records: [
          {
            sessionId: "parent",
            workingDirectory: "/project",
            sessionDirectory: "/cake/sessions",
            profile: "ProjectSession",
            transcriptPersisted: true,
            inputs: [],
            state: "stopped",
          },
        ],
      });
      yield* f.notice("FYI");
      yield* f.pass();
      yield* advance(UPDATE_BATCH_WINDOW_MS);
      yield* f.pass();
      assert.equal(f.admitted.length, 0);
      assert.ok(yield* f.batch());
    }),
  );
});

describe("batch reminder", () => {
  it("is split from model text as a Cake context block", () => {
    const split = splitUpdateBatchReminder(
      "<system-reminder>\nCake batched updates\nBody\n</system-reminder>",
    );
    assert.equal(split.text, "");
    assert.ok(split.reminder);
  });
});
