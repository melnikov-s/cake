import { it } from "@effect/vitest";
import { Context, Effect, Fiber, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import { Browser } from "../../../../src/services/browser/Browser";
import { RemoteBrowserLive } from "../../../../src/services/browser/RemoteBrowserLive";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../../../src/services/clients/ClientConnections";
import { ClientEvents } from "../../../../src/services/clients/ClientEvents";
import { ClientEventsLive } from "../../../../src/services/clients/ClientEventsLive";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import {
  RendererRequestCoordinator,
  RendererRequestCoordinatorLive,
} from "../../../../src/services/renderer-requests/RendererRequestCoordinator";
import type { CakeEvent } from "../../../../src/ipc/cake-rpc-contract";

it.effect(
  "backend browser has no Chromium; project access and desktop binding gate agent requests, disconnect releases pending",
  () =>
    Effect.gen(function* () {
      const foundation = Layer.mergeAll(
        ClientConnectionsLive,
        ClientEventsLive,
        Layer.mock(ProjectAccess, {
          isAllowed: (path: string) => Effect.succeed(path === "/allowed"),
        }),
      );
      const requests = RendererRequestCoordinatorLive.pipe(Layer.provide(foundation));
      const context = yield* Layer.build(
        Layer.mergeAll(
          foundation,
          requests,
          RemoteBrowserLive.pipe(Layer.provide(Layer.merge(foundation, requests))),
        ),
      );
      const browser = Context.get(context, Browser);
      const coordinator = Context.get(context, RendererRequestCoordinator);
      const clients = Context.get(context, ClientConnections);
      const clientEvents = Context.get(context, ClientEvents);
      expect(
        (yield* browser.enterProjectBrowser("session", "/denied").pipe(Effect.exit))._tag,
      ).toBe("Failure");
      expect(
        (yield* browser.enterProjectBrowser("session", "/allowed").pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const viewer = clients.socket();
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, viewer);
      expect(
        (yield* browser.enterProjectBrowser("session", "/allowed").pipe(Effect.exit))._tag,
      ).toBe("Failure");
      const desktop = clients.desktop(1234);
      const events = yield* Queue.unbounded<CakeEvent>();
      const ready = yield* Queue.unbounded<void>();
      yield* clientEvents.application(desktop).pipe(
        Stream.runForEach((event) =>
          event.type === "renderer-events-ready"
            ? Queue.offer(ready, undefined)
            : Queue.offer(events, event),
        ),
        Effect.forkScoped,
      );
      yield* Queue.take(ready);
      yield* coordinator.bind({ _tag: "ProjectSession", sessionId: "session" }, desktop);
      const enter = yield* browser
        .enterProjectBrowser("session", "/allowed")
        .pipe(Effect.forkChild({ startImmediately: true }));
      const request = yield* Queue.take(events);
      if (request.type !== "browser-native-requested") throw new Error("No browser request");
      expect(request.operation).toBe("enter");
      yield* coordinator.respondBrowserNative(desktop, "session", request.requestId, {
        status: "completed",
        value: null,
      });
      yield* Fiber.join(enter);
      const cdp = yield* browser
        .sendProjectCdp("session", "/allowed", "Runtime.evaluate", {})
        .pipe(Effect.forkChild({ startImmediately: true }));
      const second = yield* Queue.take(events);
      if (second.type !== "browser-native-requested") throw new Error("No CDP request");
      yield* coordinator.releaseConnection(desktop);
      expect((yield* Fiber.await(cdp))._tag).toBe("Failure");
      expect(
        (yield* coordinator
          .respondBrowserNative(desktop, "session", second.requestId, {
            status: "completed",
            value: {},
          })
          .pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
);
