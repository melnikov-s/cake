import { it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Queue, Schema } from "effect";
import { describe, expect } from "vitest";
import { artifactHandlers } from "../../../src/ipc/server/ArtifactHandlers";
import { applicationStateHandlers } from "../../../src/ipc/server/ApplicationStateHandlers";
import { RendererConnection } from "../../../src/ipc/protocol/RendererConnectionMiddleware";
import {
  applicationEventSchema,
  type CakeEvent,
} from "../../../src/contracts/application/cake-rpc-contract";
import {
  ArtifactRevision,
  decodeArtifactLineageId,
} from "../../../src/contracts/artifacts/artifact-lineage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ArtifactRuntime } from "../../../src/services/artifact-runtime/ArtifactRuntime";
import { ArtifactRuntimeLive } from "../../../src/services/artifact-runtime/ArtifactRuntimeLive";
import { ArtifactRuntimeHostLive } from "../../../src/layers/ArtifactRuntimeHostLive";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { modelPresetPromptsTestLayer } from "../helpers/modelPresetPrompts";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeSessionRuntimes, PiSessionError } from "../../../src/services/pi/CakeSessionRuntimes";
import * as artifactCommands from "../../../src/domain/artifacts/artifactCommands";
import {
  ClientConnectionsLive,
  ClientConnections,
} from "../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import {
  RendererRequestCoordinatorLive,
  RendererRequestCoordinator,
} from "../../../src/services/renderer-requests/RendererRequestCoordinator";
import { unusedEndpointServices } from "../ipc/rpc-endpoint-test-backend";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "../domain/projectSessionRuntimeTestLayer";
import { createRendererStoreFixture } from "./renderer-store-fixture";

const lineageId = decodeArtifactLineageId("unlinked-global-widget");
const revision = Schema.decodeUnknownSync(ArtifactRevision)({
  lineageId,
  metadata: {
    revision: 1,
    digest: "a".repeat(64),
    kind: "widget",
    publishedAt: "2026-01-01T00:00:00Z",
    publishedBySessionId: "creator",
    workingDirectory: "/project",
  },
  snapshot: {
    protocol: "cake.artifact/v1",
    id: lineageId,
    sessionId: "creator",
    revision: 1,
    kind: "widget",
    title: "Global widget",
    fallback: { markdown: "Widget" },
    payload: {
      language: "html",
      source: "<div>Widget</div>",
      brief: "Widget",
      browser: { digest: "b".repeat(64) },
      runtime: {
        source: `return { lifecycle: { start: () => cake("app.state") }, tools: { window: () => cake("app.state") } };`,
        tools: [
          {
            name: "window",
            description: "Read the invoking window",
            inputSchema: { type: "object" },
            outputSchema: { type: "object" },
          },
        ],
      },
    },
  },
});

const fixture = Effect.gen(function* () {
  const events = yield* Queue.unbounded<{ connectionId: number; event: CakeEvent }>();
  const clients = Layer.mock(ClientEvents, {
    broadcast: () => {},
    sendTo: (connectionId, event) => {
      const parsed = Schema.decodeUnknownSync(applicationEventSchema)(event);
      Queue.offerUnsafe(events, { connectionId, event: parsed });
      return true;
    },
  });
  const transport = Layer.merge(ClientConnectionsLive, clients);
  const storage = Layer.mock(ArtifactStorage, { read: () => Effect.succeed(revision) });
  const runtime = ArtifactRuntimeLive.pipe(Layer.provide(Layer.merge(storage, clients)));
  const context = yield* Layer.build(
    Layer.mergeAll(
      modelPresetPromptsTestLayer,
      unusedEndpointServices,
      WorkflowTestLive,
      makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
      RendererRequestCoordinatorLive.pipe(Layer.provideMerge(transport)),
      storage,
      runtime,
      Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
    ),
  );
  yield* Layer.build(ArtifactRuntimeHostLive).pipe(Effect.provide(context));
  const connectionId = Context.get(context, ClientConnections).desktop(42);
  const connection = { connectionId, correlationId: "global-widget-ui" };
  const run = Effect.runPromiseWith(Context.add(context, RendererConnection, connection));
  const renderer = createRendererStoreFixture({
    client: {
      application: {
        respondWindowControl: (payload) =>
          run(applicationStateHandlers["application.respondWindowControl"](payload)),
      },
    },
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => renderer[Symbol.dispose]()));
  return {
    context: Context.add(context, RendererConnection, connection),
    connectionId,
    events,
    renderer,
  };
});

describe("Global widget window bridge", () => {
  it.effect(
    "routes an unlinked widget's real RPC through its actual window and canonical controls",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          for (const [command, input] of [
            ["app.state", {}],
            ["settings.window.get", { section: "appearance" }],
            ["settings.open", { page: "appearance" }],
          ] as const) {
            const pending = yield* artifactHandlers["artifacts.cakeCall"]({
              lineageId,
              command,
              input,
            }).pipe(Effect.forkChild);
            const { connectionId, event } = yield* Queue.take(f.events);
            expect(connectionId).toBe(f.connectionId);
            expect(event.type).toBe("window-control-requested");
            if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
            expect(event).not.toHaveProperty("source");
            expect(event).not.toHaveProperty("sessionId");
            yield* Effect.promise(() =>
              f.renderer.root.applicationControlStore.handleWindowRequest(event),
            );
            expect(yield* Fiber.join(pending)).toMatchObject({ ok: true, command });
          }
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect("keeps UI tool startup and calls window-bound but not later background work", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const pending = yield* artifactHandlers["artifacts.callTool"]({
          lineageId,
          name: "window",
          input: {},
        }).pipe(Effect.forkChild);
        // Cold start and tool execution both retain this invocation's actual window.
        for (let index = 0; index < 2; index++) {
          const { connectionId, event } = yield* Queue.take(f.events);
          expect(connectionId).toBe(f.connectionId);
          if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
          expect(event).not.toHaveProperty("source");
          yield* Effect.promise(() =>
            f.renderer.root.applicationControlStore.handleWindowRequest(event),
          );
        }
        expect(yield* Fiber.join(pending)).toMatchObject({ ok: true, command: "app.state" });
        if (revision.snapshot.kind !== "widget" || !revision.snapshot.payload.runtime)
          throw new Error("Missing runtime");
        const background = yield* (yield* ArtifactRuntime)
          .call({
            target: {
              lineageId,
              revision: revision.metadata.revision,
              runtime: revision.snapshot.payload.runtime,
            },
            name: "window",
            input: {},
          })
          .pipe(Effect.flip);
        expect(background.message).toContain("no actual calling session");
        expect(yield* Queue.size(f.events)).toBe(0);
      }).pipe(Effect.provide(f.context));
    }),
  );

  it.effect(
    "retains canonical validation and genuine caller requirements without inventing a session",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* Effect.gen(function* () {
          const pending = yield* artifactHandlers["artifacts.cakeCall"]({
            lineageId,
            command: "settings.window.update",
            input: { invalid: true },
          }).pipe(Effect.forkChild);
          const { event } = yield* Queue.take(f.events);
          if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
          yield* Effect.promise(() =>
            f.renderer.root.applicationControlStore.handleWindowRequest(event),
          );
          expect(yield* Fiber.join(pending)).toMatchObject({ ok: false });
          expect(
            yield* artifactHandlers["artifacts.cakeCall"]({
              lineageId,
              command: "sessions.list-family",
              input: {},
            }),
          ).toMatchObject({ ok: false });
          const missingWindow = yield* artifactCommands
            .invoke("app.state", {}, { artifactId: lineageId })
            .pipe(Effect.flip);
          expect(missingWindow.message).toContain("no actual calling session");
          expect(yield* Queue.size(f.events)).toBe(0);
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect(
    "keeps genuine caller provenance and uses its session gateway only for unhandled controls",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const acquired: string[] = [];
        const sessions = Layer.mock(CakeSessionRuntimes, {
          acquireSession: (sessionId) => {
            acquired.push(sessionId);
            return Effect.fail(
              new PiSessionError({
                operation: "acquireSession",
                message: "Expected session gateway boundary",
              }),
            );
          },
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* RendererRequestCoordinator;
          // The UI's connection wins over the genuine caller's other presentation binding.
          yield* coordinator.bind(
            { _tag: "CakeChatSession", sessionId: CAKE_CHAT_SESSION_ID },
            f.connectionId + 1,
          );
          for (const command of ["app.state", "session.info"]) {
            const pending = yield* artifactHandlers["artifacts.cakeCall"]({
              lineageId,
              command,
              input: {},
              sessionId: CAKE_CHAT_SESSION_ID,
            }).pipe(Effect.result, Effect.forkChild);
            const { connectionId, event } = yield* Queue.take(f.events);
            expect(connectionId).toBe(f.connectionId);
            if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
            expect(event.source).toMatchObject({
              kind: "cake-chat",
              sessionId: CAKE_CHAT_SESSION_ID,
            });
            yield* Effect.promise(() =>
              f.renderer.root.applicationControlStore.handleWindowRequest(event),
            );
            const outcome = yield* Fiber.join(pending);
            if (command === "app.state")
              expect(outcome).toMatchObject({ _tag: "Success", success: { ok: true } });
            else
              expect(outcome).toMatchObject({
                _tag: "Failure",
                failure: { message: "Expected session gateway boundary" },
              });
          }
          expect(acquired).toEqual([CAKE_CHAT_SESSION_ID]);
        }).pipe(Effect.provide(sessions), Effect.provide(f.context));
      }),
  );

  it.effect(
    "preserves user-owned navigation permission and truthfully rejects missing session controls",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        f.renderer.root.settingsStore.agentNavigation.setEnabled(false);
        yield* Effect.gen(function* () {
          for (const command of ["settings.open", "session.info"]) {
            const pending = yield* artifactHandlers["artifacts.cakeCall"]({
              lineageId,
              command,
              input: command === "settings.open" ? { page: "appearance" } : {},
            }).pipe(Effect.result, Effect.forkChild);
            const { event } = yield* Queue.take(f.events);
            if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
            yield* Effect.promise(() =>
              f.renderer.root.applicationControlStore.handleWindowRequest(event),
            );
            const result = yield* Fiber.join(pending);
            if (command === "settings.open")
              expect(result).toMatchObject({
                _tag: "Success",
                success: { ok: false, error: expect.stringContaining("disabled") },
              });
            else
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: { message: expect.stringContaining("no actual calling session") },
              });
          }
          expect(f.renderer.root.appShellStore.selection.kind).not.toBe("settings");
        }).pipe(Effect.provide(f.context));
      }),
  );

  it.effect("settles only on the dispatched window and cancels with its connection", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const pending = yield* artifactHandlers["artifacts.cakeCall"]({
          lineageId,
          command: "app.state",
          input: {},
        }).pipe(Effect.forkChild);
        const { event } = yield* Queue.take(f.events);
        if (event.type !== "window-control-requested") throw new Error("Wrong renderer event");
        const coordinator = yield* RendererRequestCoordinator;
        const wrongWindow = yield* coordinator
          .respondWindowControl(f.connectionId + 1, event.controlRequestId, {
            handled: true,
            result: {},
          })
          .pipe(Effect.flip);
        expect(wrongWindow.message).toContain("wrong renderer connection");
        yield* coordinator.releaseConnection(f.connectionId);
        expect(yield* Fiber.join(pending)).toMatchObject({ ok: false });
      }).pipe(Effect.provide(f.context));
    }),
  );
});
