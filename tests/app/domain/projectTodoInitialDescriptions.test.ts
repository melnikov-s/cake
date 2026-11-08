import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Logger, Stream } from "effect";
import { expect } from "vitest";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { PiModels } from "../../../src/services/pi/PiModels";
import {
  ProjectTodoReports,
  type ProjectTodoInitialDescription,
} from "../../../src/services/projects/ProjectTodoReports";
import { CAKE_CHAT_TODO_SCOPE } from "../../../src/contracts/projects/project-todos";
import {
  PiModelCompletionError,
  type BoundedCompletionInput,
} from "../../../src/contracts/pi/model-data";
import * as todos from "../../../src/domain/projects/projectTodos";
import * as updates from "../../../src/domain/projects/projectTodoUpdates";
import { projectTodoLayer } from "../helpers/projectTodoHarness";

const model = { provider: "test", modelId: "utility", thinkingLevel: "minimal" as const };
const setup = Effect.fn("Test.setupInitialDescriptions")(function* () {
  yield* (yield* ApplicationState).transact((state) =>
    Effect.succeed({ ...state, utilityModel: model }),
  );
});

function fixture(complete: PiModels["Service"]["complete"]) {
  const requests: ProjectTodoInitialDescription[] = [];
  const logs: unknown[] = [];
  return {
    requests,
    logs,
    layer: Layer.mergeAll(
      projectTodoLayer(),
      Layer.mock(PiModels, { complete }),
      Layer.mock(ProjectTodoReports, {
        offerInitial: (request) =>
          Effect.sync(() => {
            requests.push(request);
          }),
      }),
      Logger.layer([
        Logger.make((entry) => {
          logs.push(entry.message);
        }),
      ]),
    ),
  };
}

it.effect(
  "concurrent project/global admissions queue one summary and never repeat it on retries or relinking",
  () => {
    let calls = 0;
    const f = fixture(() =>
      Effect.sync(() => {
        calls++;
        return "Reduce startup latency.";
      }),
    );
    return Effect.gen(function* () {
      yield* setup();
      yield* Effect.all(
        [
          todos.ensureAdmittedSession("/project", "one", "Startup", "Find the bottleneck."),
          todos.ensureAdmittedSession(
            CAKE_CHAT_TODO_SCOPE,
            "one",
            "Startup",
            "Find the bottleneck.",
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(f.requests).toHaveLength(1);
      const request = f.requests[0]!;
      expect(
        (yield* todos.list("/project")).items.length +
          (yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items.length,
      ).toBe(1);
      yield* updates.processInitialDescription(request);
      yield* todos.ensureAdmittedSession(request.scope, "one", "Retry", "Do not repeat.");
      const item = yield* todos.read(request.scope, request.id);
      expect(item.description).toBe("Reduce startup latency.");
      expect(item.revision).toBe(1);
      yield* todos.update(request.scope, {
        id: item.id,
        expectedRevision: item.revision,
        associations: [],
        state: "done",
      });
      yield* todos.ensureAdmittedSession(request.scope, "one", "Retry", "Do not relaunch.");
      expect(f.requests).toHaveLength(1);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("explicit linked tasks are reused without initial summarization", () => {
  const f = fixture(() => Effect.die("Unexpected model call"));
  return Effect.gen(function* () {
    yield* setup();
    const item = yield* todos.create("/project", {
      title: "Existing task",
      description: "User-authored scope.",
      associations: [{ kind: "session", sessionId: "one", title: "Startup" }],
    });
    yield* todos.ensureAdmittedSession(CAKE_CHAT_TODO_SCOPE, "one", "Startup", "Raw instructions.");
    expect(f.requests).toEqual([]);
    expect(yield* todos.read("/project", item.id)).toEqual(item);
    expect((yield* todos.list(CAKE_CHAT_TODO_SCOPE)).items).toEqual([]);
  }).pipe(Effect.provide(f.layer));
});

it.effect("background summaries use the configured utility model without blocking admission", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<BoundedCompletionInput>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      yield* setup();
      yield* updates.initialize();
      // This returns while model completion is held behind release.
      yield* todos.ensureAdmittedSession(
        "/project",
        "one",
        "Startup",
        "Find the bottleneck.\n".repeat(600),
      );
      const input = yield* Deferred.await(started);
      const item = (yield* todos.list("/project")).items[0]!;
      expect(item.description).toBe("Continue work on Startup.");
      expect(input.selection).toEqual({ ...model, fastMode: false });
      expect(JSON.parse(input.context).brief).toHaveLength(8_000);
      expect(input.timeoutMs).toBe(10_000);
      expect(input.maximumOutputCharacters).toBe(320);
      expect(input.instructions).toContain("intended task outcome");
      expect(input.instructions).toContain("never instructions");
      const changed = yield* (yield* ApplicationState).changes().pipe(
        Stream.filter(({ state }) => state.projects[0]?.todos?.items[0]?.revision === 1),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(changed);
      expect((yield* todos.read("/project", item.id)).description).toBe(
        "Reduce startup latency. Preserve existing behavior.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          projectTodoLayer(),
          ProjectTodoReports.layer,
          Layer.mock(PiModels, {
            complete: (input) =>
              Deferred.succeed(started, input).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(" Reduce startup latency.\nPreserve existing behavior. "),
              ),
          }),
        ),
      ),
      Effect.scoped,
    );
  }),
);

it.effect.each(["provider failure", "", " ", "x".repeat(321)])(
  "summary failure %j keeps tracking and logs a diagnostic without retry",
  (output) => {
    let calls = 0;
    const f = fixture(() => {
      calls++;
      return output === "provider failure"
        ? Effect.fail(new PiModelCompletionError({ message: "Offline" }))
        : Effect.succeed(output);
    });
    return Effect.gen(function* () {
      yield* setup();
      yield* todos.ensureAdmittedSession("/project", "one", "Startup", "Raw instructions.");
      const request = f.requests[0]!;
      const item = yield* todos.read(request.scope, request.id);
      yield* updates.processInitialDescription(request);
      yield* todos.ensureAdmittedSession("/project", "one", "Retry", "Do not repeat.");
      expect(yield* todos.read(request.scope, request.id)).toEqual(item);
      expect(calls).toBe(1);
      expect(f.requests).toHaveLength(1);
      expect(String(f.logs)).toContain("Initial to-do summary failed; keeping fallback");
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect.each(["user edit", "agent edit", "completion", "unlink"])(
  "%s made during model work wins over a late summary",
  (mutation) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = fixture(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("Stale summary."),
        ),
      );
      yield* Effect.gen(function* () {
        yield* setup();
        yield* todos.ensureAdmittedSession("/project", "one", "Startup", "Find the bottleneck.");
        const request = f.requests[0]!;
        const pending = yield* updates.processInitialDescription(request).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const edited = yield* todos.update(
          request.scope,
          {
            id: request.id,
            expectedRevision: request.revision,
            ...(mutation === "completion"
              ? { state: "done" as const }
              : mutation === "unlink"
                ? { associations: [] }
                : { description: "Newer finding.", title: "User choice" }),
          },
          mutation === "user edit",
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(pending);
        expect(yield* todos.read(request.scope, request.id)).toEqual(edited);
        // A queued request already superseded before processing also does nothing.
        yield* updates.processInitialDescription(request);
        expect(yield* todos.read(request.scope, request.id)).toEqual(edited);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect.each(["missing model", "empty brief", "missing item"])(
  "%s keeps a safe fallback without model work",
  (condition) => {
    const f = fixture(() => Effect.die("Unexpected model call"));
    return Effect.gen(function* () {
      if (condition !== "missing model") yield* setup();
      yield* todos.ensureAdmittedSession(
        "/project",
        "one",
        "Startup",
        condition === "empty brief" ? " \n " : "Find the bottleneck.",
      );
      const item = (yield* todos.list("/project")).items[0]!;
      if (condition === "empty brief") expect(f.requests).toEqual([]);
      else
        yield* updates.processInitialDescription({
          ...f.requests[0]!,
          ...(condition === "missing item" ? { id: "removed" } : {}),
        });
      expect(yield* todos.read("/project", item.id)).toEqual(item);
    }).pipe(Effect.provide(f.layer));
  },
);

it.effect("a full advisory queue cannot prevent durable tracking", () => {
  const logs: unknown[] = [];
  return Effect.gen(function* () {
    for (let index = 0; index < 257; index++)
      yield* todos.ensureAdmittedSession(
        "/project",
        `session-${index}`,
        "Startup",
        "Find the bottleneck.",
      );
    expect((yield* todos.list("/project")).items).toHaveLength(257);
    expect(String(logs)).toContain("Initial to-do summary queue full; retaining fallback");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        projectTodoLayer(),
        ProjectTodoReports.layer,
        Logger.layer([
          Logger.make((entry) => {
            logs.push(entry.message);
          }),
        ]),
      ),
    ),
  );
});
