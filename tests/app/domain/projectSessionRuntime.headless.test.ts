import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Layer, Scope, Stream } from "effect";
import { expect, vi } from "vitest";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimesAdapter,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";

const input = {
  sessionId: "session-1",
  newSession: true,
  location: {
    projectName: "project",
    projectPath: "/project",
    workingDirectory: "/project",
    sessionDirectory: "/cake/sessions",
    resolvedSessionDirectory: "/cake/resolved",
  },
};
const adapter = (
  createRuntime: CakeSessionRuntimesAdapter["createRuntime"],
): CakeSessionRuntimesAdapter => ({
  createRuntime,
  sessionIds: () => Stream.empty,
  catalog: () => Stream.empty,
  catalogEntry: () => Effect.succeed(undefined),
  inspect: () => Effect.succeed(undefined),
  changelog: () => Effect.succeed(""),
});
const dependencies = Layer.mergeAll(
  makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
  Layer.mock(ApplicationState, { snapshot: () => defaultApplicationState() }),
  SessionCatalogChanges.layer,
  Layer.mock(SessionArchiveStorage, {}),
  Layer.mock(SessionFamilyStorage, {
    familyForMember: () => Effect.succeed(undefined),
    withMemberLock: (_sessionId, effect) => effect,
    settleTurn: () => Effect.void,
  }),
  Layer.mock(ManagedWorktrees, {}),
);

it.effect.each([false, true])(
  "headless_project_turn_survives_request_scope (reconnect before completion: %s)",
  (reconnect) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const complete = yield* Deferred.make<void>();
      const disposed = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      let acquisitions = 0;
      let completed = false;
      const runtimes = makeCakeSessionRuntimesLayer(
        adapter((options) =>
          Effect.sync(() => {
            acquisitions++;
            return {
              ...fakeRuntime(options, () => {
                Deferred.doneUnsafe(disposed, Effect.void);
              }),
              snapshot: async () => ({
                ...snapshot,
                parts: completed
                  ? [
                      {
                        id: "answer",
                        kind: "text" as const,
                        role: "assistant" as const,
                        text: "Finished without a client",
                        status: "complete" as const,
                      },
                    ]
                  : [],
              }),
              prompt: () =>
                Effect.runPromise(
                  Effect.gen(function* () {
                    yield* Deferred.succeed(entered, undefined);
                    yield* Deferred.await(complete);
                    completed = true;
                  }),
                ),
            };
          }),
        ),
      );
      const context = yield* Layer.build(Layer.merge(dependencies, runtimes));
      yield* Effect.gen(function* () {
        const sessions = yield* CakeSessionRuntimes;
        const acquired = yield* acquireOptions(input);
        const options = {
          ...acquired,
          onTurnSettled: (event: Parameters<NonNullable<typeof acquired.onTurnSettled>>[0]) =>
            (acquired.onTurnSettled?.(event) ?? Effect.void).pipe(
              Effect.andThen(Deferred.succeed(settled, undefined)),
            ),
        };
        const first = yield* Scope.make();
        const handle = yield* sessions
          .acquire(options)
          .pipe(Effect.provideService(Scope.Scope, first));
        const turnId = yield* handle.prompt("work without desktop capabilities");
        assert.ok(turnId);
        yield* Deferred.await(entered);
        yield* Scope.close(first, Exit.void);
        expect(yield* Deferred.isDone(disposed)).toBe(false);
        const second = yield* Scope.make();
        const reconnected = reconnect
          ? yield* sessions.acquire(options).pipe(Effect.provideService(Scope.Scope, second))
          : undefined;
        expect(acquisitions).toBe(1);
        yield* Deferred.succeed(complete, undefined);
        yield* Deferred.await(settled);
        expect(completed).toBe(true);
        if (reconnected) {
          expect((yield* reconnected.snapshot()).parts).toEqual([
            {
              id: "answer",
              kind: "text",
              role: "assistant",
              text: "Finished without a client",
              status: "complete",
            },
          ]);
          expect(yield* Deferred.isDone(disposed)).toBe(false);
        }
        yield* Scope.close(second, Exit.void);
        yield* Deferred.await(disposed);
      }).pipe(Effect.provide(context));
    }),
);

it.effect("missing_desktop_controls_reject_immediately_without_renderer_requests", () =>
  Effect.gen(function* () {
    const options = yield* acquireOptions(input);
    yield* Effect.promise(async () => {
      assert.ok(options.runtime.vscodeControl);
      const signal = new AbortController().signal;
      await expect(options.runtime.vscodeControl.enter(signal)).rejects.toThrow(
        "VS Code is unavailable",
      );
      await expect(options.runtime.vscodeControl.runScript("return 1", {}, signal)).rejects.toThrow(
        "VS Code is unavailable",
      );
      expect(options.runtime.browserControl).toBeUndefined();
    });
  }).pipe(
    Effect.provide(
      Layer.merge(
        dependencies,
        makeCakeSessionRuntimesLayer(adapter(() => Effect.die("Unexpected Pi acquisition"))),
      ),
    ),
  ),
);

it.effect("provided_desktop_controls_retain_native_editor_behavior", () =>
  Effect.gen(function* () {
    const script = vi.fn();
    const native = Layer.mock(VsCodeServer, {
      leaseFor: () => undefined,
      runProjectScript: (cwd, source, value) =>
        Effect.sync(() => {
          script(cwd, source, value);
          return { status: "completed" as const, value };
        }),
    });
    const context = yield* Layer.build(
      Layer.mergeAll(
        dependencies,
        native,
        makeCakeSessionRuntimesLayer(adapter(() => Effect.die("Unexpected Pi acquisition"))),
      ),
    );
    const options = yield* acquireOptions(input).pipe(Effect.provide(context));
    yield* Effect.promise(async () => {
      assert.ok(options.runtime.vscodeControl);
      expect(
        await options.runtime.vscodeControl.runScript(
          "return input",
          { value: 42 },
          new AbortController().signal,
        ),
      ).toEqual({ status: "completed", value: { value: 42 } });
    });
    expect(script).toHaveBeenCalledWith("/project", "return input", { value: 42 });
    expect(Context.get(context, CakeSessionRuntimes)).toBeDefined();
  }),
);
