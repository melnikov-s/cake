import { it } from "@effect/vitest";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  SubscriptionRef,
} from "effect";
import { expect } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import {
  initialize,
  removeRegistration,
  setEnabled,
} from "../../../src/domain/worktrees/autoMergeReadiness";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  ApplicationStorage,
  makeApplicationStorageLive,
} from "../../../src/services/storage/ApplicationStorage";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../../src/services/storage/SessionFamilyStorage";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const projectPath = "/PRIVATE_PROJECT";

function fixture(
  beforeWrite: (path: string) => Effect.Effect<void, PlatformError.PlatformError>,
  enabled = false,
) {
  const { files, fileSystem } = familyStorageHarness();
  const writes: string[] = [];
  const fs = Layer.succeed(
    FileSystem.FileSystem,
    FileSystem.makeNoop({
      ...fileSystem,
      writeFileString: (path, content, options) =>
        Effect.gen(function* () {
          writes.push(path.includes("application.json") ? "preference" : "authorization");
          yield* beforeWrite(path);
          return yield* fileSystem.writeFileString(path, content, options);
        }),
    }),
  );
  const applicationStorage = makeApplicationStorageLive("state", "prompts").pipe(
    Layer.provide(fs),
    Layer.provide(Path.layer),
  );
  const layer = Layer.mergeAll(
    ApplicationState.layer.pipe(Layer.provideMerge(applicationStorage)),
    makeSessionFamilyStorageLive("state/session-families.json").pipe(
      Layer.provide(fs),
      Layer.provide(Path.layer),
    ),
    WorktreeLandingCoordinatorLive,
  );
  const seed = Effect.gen(function* () {
    yield* (yield* ApplicationStorage).save({
      ...defaultApplicationState(),
      projects: [
        {
          path: projectPath,
          name: "Private",
          autoMergeEnabled: enabled,
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
          settings: defaultProjectSettings(),
        },
      ],
    });
    yield* (yield* ApplicationState).initialize();
    yield* initialize();
    writes.length = 0;
  });
  return { layer, seed, files, writes };
}

const enabledProjection = Effect.gen(function* () {
  const state = yield* SubscriptionRef.get((yield* WorktreeLandingCoordinator).state);
  return state.autoMergeProjects?.find((item) => item.projectPath === projectPath)?.enabled;
});

it.effect(
  "profiles the real serialized authorization and atomic preference save path without publishing early",
  () =>
    Effect.gen(function* () {
      let nanos = 0n;
      const clock = yield* Clock.Clock;
      const locked = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const authorizing = yield* Deferred.make<void>();
      const releaseAuthorization = yield* Deferred.make<void>();
      const saving = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const messages: unknown[] = [];
      let armed = false;
      const test = fixture((path) =>
        !armed
          ? Effect.void
          : path.includes("application.json")
            ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(releaseSave)))
            : Deferred.succeed(authorizing, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAuthorization)),
              ),
      );
      yield* Effect.gen(function* () {
        yield* test.seed;
        const original = test.files.get("state/application.json");
        armed = true;
        const storage = yield* SessionFamilyStorage;
        const holder = yield* storage
          .withCreationLock(
            `auto-merge-toggle:${projectPath}`,
            Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(releaseLock))),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(locked);
        const toggling = yield* setEnabled(projectPath, true).pipe(
          Effect.forkScoped({ startImmediately: true }),
        );
        expect(test.writes).toEqual([]);
        expect(yield* enabledProjection).toBe(false);
        nanos += 1_000_000_000n;
        yield* Deferred.succeed(releaseLock, undefined);
        yield* Deferred.await(authorizing);
        expect(test.writes).toEqual(["authorization"]);
        expect(yield* enabledProjection).toBe(false);
        nanos += 2_000_000_000n;
        yield* Deferred.succeed(releaseAuthorization, undefined);
        yield* Deferred.await(saving);
        expect(test.writes).toEqual(["authorization", "preference"]);
        expect(test.files.get("state/application.json")).toBe(original);
        expect((yield* ApplicationState).snapshot().projects[0]?.autoMergeEnabled).toBe(false);
        expect(yield* enabledProjection).toBe(false);
        nanos += 3_000_000_000n;
        yield* Deferred.succeed(releaseSave, undefined);
        yield* Fiber.join(toggling);
        yield* Fiber.join(holder);
        expect(yield* enabledProjection).toBe(true);
        expect(
          JSON.parse(test.files.get("state/application.json") ?? "{}").data.projects[0]
            .autoMergeEnabled,
        ).toBe(true);
      }).pipe(
        Effect.provide(test.layer),
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanosUnsafe: () => nanos,
          monotonicTimeNanos: Effect.sync(() => nanos),
        }),
        Effect.provide(
          Logger.layer([
            Logger.make(({ message }) => {
              messages.push(message);
            }),
          ]),
        ),
      );
      expect(messages).toContainEqual([
        "Slow auto-merge toggle",
        {
          enabled: true,
          completed: true,
          phase: "publish",
          phasesMs: { wait: 1_000, authorization: 2_000, preference: 3_000, publish: 0 },
          totalMs: 6_000,
        },
      ]);
      expect(JSON.stringify(messages)).not.toContain("PRIVATE");
    }),
);

it.effect.each([
  { boundary: "authorization", enabled: false },
  { boundary: "preference", enabled: false },
  { boundary: "preference", enabled: true },
])(
  "$boundary rejection preserves durable enabled=$enabled state and allows retry",
  ({ boundary, enabled }) => {
    let armed = false;
    const test = fixture(
      (path) =>
        armed &&
        path.includes(boundary === "preference" ? "application.json" : "session-families.json")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "AutoMergeTest",
                method: "writeFileString",
              }),
            )
          : Effect.void,
      enabled,
    );
    return Effect.gen(function* () {
      yield* test.seed;
      const original = test.files.get("state/application.json");
      armed = true;
      const result = yield* Effect.result(setEnabled(projectPath, !enabled));
      expect(result._tag).toBe("Failure");
      expect(test.files.get("state/application.json")).toBe(original);
      expect((yield* ApplicationState).snapshot().projects[0]?.autoMergeEnabled).toBe(enabled);
      expect(yield* enabledProjection).toBe(enabled);
      expect(test.writes).toEqual(
        boundary === "authorization"
          ? ["authorization"]
          : enabled
            ? ["preference"]
            : ["authorization", "preference"],
      );
      armed = false;
      yield* setEnabled(projectPath, !enabled);
      expect(yield* enabledProjection).toBe(!enabled);
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("disable skips readiness authorization but waits for durable preference acceptance", () =>
  Effect.gen(function* () {
    const saving = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let armed = false;
    const test = fixture(
      () =>
        armed
          ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Effect.void,
      true,
    );
    yield* Effect.gen(function* () {
      yield* test.seed;
      armed = true;
      const toggling = yield* setEnabled(projectPath, false).pipe(Effect.forkScoped);
      yield* Deferred.await(saving);
      expect(test.writes).toEqual(["preference"]);
      expect(yield* enabledProjection).toBe(true);
      expect((yield* ApplicationState).snapshot().projects[0]?.autoMergeEnabled).toBe(true);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(toggling);
      expect(yield* enabledProjection).toBe(false);
      expect(
        JSON.parse(test.files.get("state/application.json") ?? "{}").data.projects[0]
          .autoMergeEnabled,
      ).toBe(false);
    }).pipe(Effect.provide(test.layer));
  }),
);

it.effect("removes a project whose family document has never recorded auto-merge requests", () => {
  const test = fixture(() => Effect.void);
  return Effect.gen(function* () {
    yield* test.seed;
    const state = yield* removeRegistration(projectPath);
    expect(state.projects).toEqual([]);
    const family = JSON.parse(test.files.get("state/session-families.json") ?? "{}");
    expect(family.data?.autoMergeRequests ?? []).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});
