import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { expect } from "vitest";
import { TestClock } from "effect/testing";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { PiModels } from "../../../src/services/pi/PiModels";
import { ProjectTodoReports } from "../../../src/services/projects/ProjectTodoReports";
import {
  defaultApplicationState,
  ApplicationState as State,
} from "../../../src/contracts/application/application-data";
import {
  CAKE_CHAT_TODO_SCOPE,
  PROJECT_TODO_SUMMARY_GUIDANCE,
} from "../../../src/contracts/projects/project-todos";
import {
  PiModelCompletionError,
  type BoundedCompletionInput,
} from "../../../src/contracts/pi/model-data";
import { upsertProject } from "../../../src/domain/application/application";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as updates from "../../../src/domain/projects/projectTodoUpdates";

const model = { provider: "test", modelId: "utility", thinkingLevel: "minimal" as const };
const report = {
  sessionId: "session-one",
  projectPath: "/project",
  text: "Retry fix committed; focused tests pass. Not merged.",
};
const work = [{ kind: "session" as const, sessionId: report.sessionId, title: "Investigation" }];

function fixture(complete: PiModels["Service"]["complete"]) {
  let persisted = defaultApplicationState();
  let writes = 0;
  const storage = Layer.succeed(
    ApplicationStorage,
    ApplicationStorage.of({
      load: () => Effect.succeed({ state: persisted, source: "current" as const }),
      save: (state) =>
        Effect.sync(() => {
          persisted = Schema.decodeUnknownSync(State)(JSON.parse(JSON.stringify(state)));
          writes++;
        }),
    }),
  );
  return {
    layer: Layer.mergeAll(
      ApplicationState.layer.pipe(Layer.provide(storage)),
      Layer.mock(PiModels, { complete }),
      ProjectTodoReports.layer,
    ),
    persisted: () => persisted,
    writes: () => writes,
  };
}

const setup = Effect.fn("Test.setup")(function* () {
  yield* upsertProject("/project", "Project");
  yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({ ...state, utilityModel: model }),
  );
  return yield* todos.create("/project", {
    title: "Fix duplicate writes",
    description: "Retry handling identified as the cause; checking a fix.",
    associations: work,
  });
});

it.effect(
  "updates linked project and global items without touching lifecycle, links or pending delivery",
  () => {
    const inputs: BoundedCompletionInput[] = [];
    const f = fixture((input) =>
      Effect.sync(() => {
        inputs.push(input);
        return "Retry fix is ready for review. Awaiting merge.";
      }),
    );
    return Effect.gen(function* () {
      const item = yield* setup();
      const global = yield* todos.create(CAKE_CHAT_TODO_SCOPE, {
        title: item.title,
        description: item.description,
        associations: work,
      });
      const unrelated = yield* todos.create("/project", {
        title: "Other topic",
        description: "Still investigating.",
      });
      yield* todos.mutateUser("/project", { _tag: "Select", selectedId: item.id });
      const before = yield* todos.list("/project");
      yield* updates.processReports([report]);
      const next = yield* todos.read("/project", item.id);
      expect(next.description).toBe("Retry fix is ready for review. Awaiting merge.");
      expect(next.revision).toBe(1);
      expect(next.state).toBe("open");
      expect(next.associations).toEqual(work);
      expect((yield* todos.list("/project")).pending).toEqual(before.pending);
      expect((yield* todos.list("/project")).selectedId).toBe(item.id);
      expect((yield* todos.read(CAKE_CHAT_TODO_SCOPE, global.id)).description).toBe(
        next.description,
      );
      expect(yield* todos.read("/project", unrelated.id)).toEqual(unrelated);
      expect(inputs).toHaveLength(2);
      expect(JSON.parse(inputs[0]!.context)).toEqual({
        title: item.title,
        currentDescription: item.description,
        newReport: report.text,
      });
      expect(inputs[0]!.selection).toEqual({ ...model, fastMode: false });
      expect(inputs[0]!.timeoutMs).toBe(10_000);
      expect(inputs[0]!.instructions).toContain(PROJECT_TODO_SUMMARY_GUIDANCE);
      expect(f.persisted().projects[0]?.todos?.items[0]?.description).toBe(next.description);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "unchanged summaries make no storage write; unlinked and done items make no model calls",
  () => {
    let calls = 0;
    const f = fixture((input) =>
      Effect.sync(() => {
        calls++;
        return JSON.parse(input.context).currentDescription;
      }),
    );
    return Effect.gen(function* () {
      const item = yield* setup();
      const writes = f.writes();
      yield* updates.processReports([report]);
      expect(f.writes()).toBe(writes);
      expect(yield* todos.read("/project", item.id)).toEqual(item);
      yield* updates.processReports([{ ...report, sessionId: "unrelated" }]);
      yield* todos.update("/project", { id: item.id, expectedRevision: 0, state: "done" });
      yield* updates.processReports([report]);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "matches a worker by public handle and parent, not the parent's session association",
  () => {
    let calls = 0;
    const f = fixture(() =>
      Effect.sync(() => {
        calls++;
        return "Worker found the cause; awaiting review.";
      }),
    );
    return Effect.gen(function* () {
      const parent = yield* setup();
      const worker = {
        parentSessionId: report.sessionId,
        handleId: "10000000-0000-4000-8000-000000000001",
      };
      const item = yield* todos.create("/project", {
        title: "Worker research",
        description: "Looking into the cause.",
        associations: [{ kind: "subagent", ...worker, title: "Research worker" }],
      });
      yield* updates.processReports([
        { ...report, subagent: { ...worker, parentSessionId: "another-parent" } },
      ]);
      expect(calls).toBe(0);
      yield* updates.processReports([{ ...report, subagent: worker }]);
      expect(calls).toBe(1);
      expect(yield* todos.read("/project", parent.id)).toEqual(parent);
      expect((yield* todos.read("/project", item.id)).state).toBe("open");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a user edit made during summarization wins over the older model result", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = fixture(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("Old report summary."),
      ),
    );
    yield* Effect.gen(function* () {
      const item = yield* setup();
      const pending = yield* updates.processReports([report]).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* todos.update(
        "/project",
        { id: item.id, expectedRevision: 0, description: "User's newer finding." },
        true,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      expect((yield* todos.read("/project", item.id)).description).toBe("User's newer finding.");
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect.each(["", " ", "x".repeat(2049)])(
  "invalid summary %j leaves the current update intact",
  (output) => {
    const f = fixture(() => Effect.succeed(output));
    return Effect.gen(function* () {
      const item = yield* setup();
      yield* updates.processReports([report]);
      expect(yield* todos.read("/project", item.id)).toEqual(item);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect(
  "provider failure keeps the description and makes no retry or foreground fallback",
  () => {
    let calls = 0;
    const f = fixture(() => {
      calls++;
      return Effect.fail(new PiModelCompletionError({ message: "Offline" }));
    });
    return Effect.gen(function* () {
      const item = yield* setup();
      yield* updates.processReports([report]);
      expect(calls).toBe(1);
      expect(yield* todos.read("/project", item.id)).toEqual(item);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("list changes never request model sorting while report summaries still work", () => {
  const inputs: BoundedCompletionInput[] = [];
  const f = fixture((input) =>
    Effect.sync(() => {
      inputs.push(input);
      return "Fix committed; awaiting merge.";
    }),
  );
  return Effect.gen(function* () {
    yield* updates.initialize();
    const first = yield* setup();
    const second = yield* todos.create("/project", {
      title: "Review choices",
      description: "Choose the target.",
    });
    yield* todos.update("/project", {
      id: second.id,
      expectedRevision: 0,
      description: "Choose the deployment target.",
    });
    yield* TestClock.adjust("10 seconds");
    expect(inputs).toHaveLength(0);

    const updated = yield* (yield* ApplicationState).changes().pipe(
      Stream.filter(({ state }) => state.projects[0]?.todos?.items[0]?.revision === 1),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* updates.offer(report);
    yield* Fiber.join(updated);
    yield* TestClock.adjust("10 seconds");
    expect(inputs).toHaveLength(1);
    expect(JSON.parse(inputs[0]!.context).title).toBe(first.title);
    expect(inputs[0]!.instructions).toContain(PROJECT_TODO_SUMMARY_GUIDANCE);
  }).pipe(Effect.provide(f.layer), Effect.scoped);
});

it.effect(
  "the background queue accepts a report immediately and publishes its summary without chat delivery",
  () => {
    const f = fixture(() => Effect.succeed("Fix committed; awaiting merge."));
    return Effect.gen(function* () {
      const item = yield* setup();
      yield* updates.initialize();
      const updated = yield* (yield* ApplicationState).changes().pipe(
        Stream.filter(({ state }) => state.projects[0]?.todos?.items[0]?.revision === 1),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* updates.offer(report);
      yield* Fiber.join(updated);
      expect((yield* todos.read("/project", item.id)).description).toBe(
        "Fix committed; awaiting merge.",
      );
    }).pipe(Effect.provide(f.layer), Effect.scoped);
  },
);
