import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { makeBackendLive } from "../../../src/backend/BackendLive";
import { resolveCakePaths } from "../../../src/config/CakePaths";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { ClientWorkspaces } from "../../../src/services/clients/ClientWorkspaces";
import { Electron } from "../../../src/services/electron/Electron";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { RendererRequestCoordinator } from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { RenderedWidgetCapture } from "../../../src/services/widgets/RenderedWidgetCapture";
import {
  ApplicationStorage,
  makeApplicationStorageLive,
} from "../../../src/services/storage/ApplicationStorage";
import { BootstrapLive } from "../../../src/main/BootstrapLive";

const home = process.env.CAKE_HOME;
assert.ok(home);
const paths = resolveCakePaths({ env: { CAKE_HOME: home } });
const project = join(home, "project");
const inputSessionId = "00000000-0000-4000-8000-000000000001";
await mkdir(project, { recursive: true });
await Effect.runPromise(
  Effect.flatMap(ApplicationStorage, (storage) =>
    storage.save({
      ...defaultApplicationState(),
      projects: [
        {
          path: project,
          name: "headless",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  ).pipe(
    Effect.provide(makeApplicationStorageLive(paths.state).pipe(Layer.provide(BootstrapLive))),
  ),
);

class HostProbe extends Context.Service<
  HostProbe,
  {
    readonly application: ApplicationState["Service"];
    readonly sessions: CakeSessionRuntimes["Service"];
    readonly events: ClientEvents["Service"];
    readonly workspaces: ClientWorkspaces["Service"];
  }
>()("test/HostProbe") {}
let acquisitions = 0;
let finalizations = 0;
let releases = 0;
const backend = makeBackendLive({ paths, homeDirectory: home }, (foundation) =>
  Layer.effect(
    HostProbe,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          acquisitions++;
        }),
        () =>
          Effect.sync(() => {
            finalizations++;
          }),
      );
      return {
        application: yield* ApplicationState,
        sessions: yield* CakeSessionRuntimes,
        events: yield* ClientEvents,
        workspaces: yield* ClientWorkspaces,
      };
    }),
  ).pipe(Layer.provide(foundation)),
);
const runtime = ManagedRuntime.make(backend);
const retainedScope = await Effect.runPromise(Scope.make());
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      const probe = yield* HostProbe;
      const sessions = yield* CakeSessionRuntimes;
      assert.equal(sessions, probe.sessions);
      assert.equal(yield* ApplicationState, probe.application);
      assert.equal(probe.application.snapshot().projects[0]?.path, project);
      assert.equal(yield* ClientEvents, probe.events);
      assert.equal(yield* ClientWorkspaces, probe.workspaces);
      assert.equal(acquisitions, 1);
      assert.equal(finalizations, 0);
      assert.equal(Option.isNone(yield* Effect.serviceOption(Electron)), true);
      const vscode = yield* VsCodeServer;
      assert.ok(["ready", "missing"].includes((yield* vscode.state()).status));
      assert.equal(Option.isNone(yield* Effect.serviceOption(RenderedWidgetCapture)), true);
      const access = yield* ProjectAccess;
      assert.equal(yield* access.isAllowed(project), true);
      const location = {
        projectName: "headless",
        projectPath: project,
        workingDirectory: project,
        sessionDirectory: paths.piSessions,
        resolvedSessionDirectory: paths.piResolvedSessions,
      };
      const options = yield* acquireOptions({
        location,
        sessionId: inputSessionId,
        newSession: true,
      });
      yield* Effect.promise(async () => {
        const signal = new AbortController().signal;
        assert.ok(options.runtime.vscodeControl);
        await assert.rejects(options.runtime.vscodeControl.enter(signal), /No renderer/);
        assert.deepEqual(await options.runtime.vscodeControl.runScript("return 1", {}, signal), {
          status: "mode-required",
        });
        assert.ok(options.runtime.generateInlineWidget);
        await assert.rejects(
          options.runtime.generateInlineWidget({
            sessionId: inputSessionId,
            brief: "Show a chart",
            fallback: "Chart unavailable",
            model: { provider: "test", id: "test" },
            signal,
          }),
          /Rendered widget capture is unavailable in this host/,
        );
      });
      const coordinator = yield* RendererRequestCoordinator;
      const result = yield* coordinator
        .requestDrawControl(
          options.runtime.sessionId ?? "",
          { _tag: "Open", boardId: "board" },
          new AbortController().signal,
        )
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      const first = yield* Scope.make();
      const second = yield* Scope.make();
      const runtimeOptions = {
        ...options,
        onRelease: (options.onRelease ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              releases++;
            }),
          ),
        ),
      };
      // Real Pi acquisition, real Cake registry. No provider turn is submitted.
      const firstHandle = yield* sessions
        .acquire(runtimeOptions)
        .pipe(Effect.provideService(Scope.Scope, first));
      const secondHandle = yield* sessions
        .acquire(runtimeOptions)
        .pipe(Effect.provideService(Scope.Scope, second));
      assert.equal(
        (yield* firstHandle.snapshot()).sessionId,
        (yield* secondHandle.snapshot()).sessionId,
      );
      yield* Scope.close(first, Exit.void);
      assert.equal(releases, 0);
      assert.equal((yield* secondHandle.snapshot()).sessionId, options.runtime.sessionId);
      yield* Scope.close(second, Exit.void);
      assert.equal(releases, 1);
      assert.equal(finalizations, 0);
      const retained = yield* acquireOptions({
        location,
        sessionId: "00000000-0000-4000-8000-000000000002",
        newSession: true,
      });
      yield* sessions
        .acquire({
          ...retained,
          onRelease: (retained.onRelease ?? Effect.void).pipe(
            Effect.andThen(
              Effect.sync(() => {
                releases++;
              }),
            ),
          ),
        })
        .pipe(Effect.provideService(Scope.Scope, retainedScope));
    }),
  );
} finally {
  await runtime.dispose();
  // Closing the backend releases the real Pi runtime even while a client lease
  // remains. Closing that now-stale client Scope must not finalize it twice.
  assert.equal(releases, 2);
  await Effect.runPromise(Scope.close(retainedScope, Exit.void));
}
assert.equal(releases, 2);
assert.equal(acquisitions, 1);
assert.equal(finalizations, 1);
console.log("headless-backend-check-ok");
