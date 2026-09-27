import { Context, Effect, Layer } from "effect";
import { expect, it } from "vitest";
import {
  ClientConnections,
  ClientConnectionsLive,
} from "../../src/services/clients/ClientConnections";
import { PreviewLeases, PreviewLeasesLive } from "../../src/services/browser/PreviewLeases";

it("issues only desktop-owned capability leases, shares one target and revokes on session/disconnect/listener close", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clientsLayer = ClientConnectionsLive;
        const context = yield* Layer.build(
          Layer.merge(clientsLayer, PreviewLeasesLive.pipe(Layer.provide(clientsLayer))),
        );
        const clients = Context.get(context, ClientConnections);
        const previews = Context.get(context, PreviewLeases);
        const browser = clients.socket();
        const desktop = clients.desktop(456);
        expect((yield* previews.acquire(browser, "session", 6400).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        expect((yield* previews.acquire(desktop, "session", 6400).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        yield* previews.configure();
        expect((yield* previews.acquire(browser, "session", 6400).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
        const first = yield* previews.acquire(desktop, "session", 6400);
        expect(first.endpoint).toMatch(/^\/preview\/[0-9a-f]{64}\/$/);
        expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(yield* previews.acquire(desktop, "session", 6400)).toEqual(first);
        const id = first.endpoint.split("/")[2] ?? "";
        expect(previews.find(id, first.secret)?.port).toBe(6400);
        expect(previews.find(id, "0".repeat(64))).toBeUndefined();
        yield* previews.releaseSession("session");
        expect(previews.find(id, first.secret)).toBeUndefined();
        const renewed = yield* previews.acquire(desktop, "session", 6400);
        expect(renewed.endpoint).not.toBe(first.endpoint);
        yield* previews.releaseConnection(desktop);
        expect(previews.find(renewed.endpoint.split("/")[2] ?? "", renewed.secret)).toBeUndefined();
        yield* previews.shutdown();
        expect((yield* previews.acquire(desktop, "session", 6400).pipe(Effect.exit))._tag).toBe(
          "Failure",
        );
      }),
    ),
  );
});
