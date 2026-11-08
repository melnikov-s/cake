import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Stream, SubscriptionRef } from "effect";
import { expect, vi } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeChatCatalogUpdate } from "../../../src/contracts/application/catalog-data";
import * as metadata from "../../../src/domain/cake-chats/cakeChatMetadata";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";

const location = { workingDirectory: "/home/user", sessionDirectory: "/cake/global" };
const project = (index: number) => ({
  path: `/project-${index}`,
  name: `Project ${index}`,
  addedAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
});
const summary = (id: string) => ({
  id,
  title: "Chat",
  created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z",
  messageCount: 100_000,
  resolved: false,
});

it.effect.each([0, 40])(
  "exact selected lookup is independent of a %s-project catalog, without acquiring Harnesses",
  (count) =>
    Effect.gen(function* () {
      const state = {
        ...defaultApplicationState(),
        projects: Array.from({ length: count }, (_, i) => project(i)),
      };
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const reads: string[] = [];
      const acquire = vi.fn(() => Effect.die("Listing must not acquire a Harness"));
      const layer = Layer.mergeAll(
        Layer.mock(ApplicationState, { snapshot: () => state }),
        Layer.mock(CakeSessionRuntimes, {
          catalogEntry: (_query, id) =>
            Effect.gen(function* () {
              reads.push(id);
              if (id !== CAKE_CHAT_SESSION_ID) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return summary(id);
            }),
          currentStatus: () => Effect.succeed(undefined),
          acquireSession: acquire,
        }),
      );
      yield* Effect.gen(function* () {
        let catalogComplete = false;
        const catalog = yield* metadata.catalog(location).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              catalogComplete = true;
            }),
          ),
          Effect.forkScoped,
        );
        if (count) yield* Deferred.await(entered);
        const selected = yield* metadata.lookup(CAKE_CHAT_SESSION_ID, location);
        expect(selected.sessionId).toBe(CAKE_CHAT_SESSION_ID);
        if (count) expect(catalogComplete).toBe(false);
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(catalog)).toHaveLength(count + 1);
        expect(reads.filter((id) => id === CAKE_CHAT_SESSION_ID)).toHaveLength(2);
        expect(acquire).not.toHaveBeenCalled();
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);

it.effect(
  "a new global chat has an exact address without creating storage or listing a phantom history",
  () =>
    Effect.gen(function* () {
      expect(yield* metadata.catalog(location)).toEqual([]);
      expect(yield* metadata.lookup(CAKE_CHAT_SESSION_ID, location)).toMatchObject({
        sessionId: CAKE_CHAT_SESSION_ID,
        messageCount: 0,
        running: false,
      });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ApplicationState, { snapshot: defaultApplicationState }),
          Layer.mock(CakeSessionRuntimes, {
            catalogEntry: () => Effect.succeed(undefined),
            currentStatus: () => Effect.succeed(undefined),
          }),
        ),
      ),
    ),
);

it.effect(
  "one initial scan, with project and catalog mutations retained while that scan is blocked",
  () =>
    Effect.gen(function* () {
      const initial = { revision: 0, state: defaultApplicationState() };
      const state = yield* SubscriptionRef.make(initial);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const updates = yield* Queue.unbounded<CakeChatCatalogUpdate>();
      const reads: string[] = [];
      let subscriptions = 0;
      let releases = 0;
      const layer = Layer.mergeAll(
        SessionCatalogChanges.layer,
        Layer.mock(ApplicationState, {
          snapshot: () => SubscriptionRef.getUnsafe(state).state,
          changes: () =>
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  subscriptions++;
                  return SubscriptionRef.changes(state);
                }),
                () =>
                  Effect.sync(() => {
                    releases++;
                  }),
              ),
            ),
        }),
        Layer.mock(CakeSessionRuntimes, {
          catalogEntry: (_query, id) =>
            Effect.gen(function* () {
              reads.push(id);
              if (reads.length === 1) {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
              }
              return summary(id);
            }),
          currentStatus: () => Effect.succeed(undefined),
        }),
      );
      yield* Effect.gen(function* () {
        const observer = yield* (yield* metadata.observeCatalog(
          { resolved: false },
          location,
        )).pipe(
          Stream.runForEach((update) => Queue.offer(updates, update)),
          Effect.forkScoped,
        );
        yield* Deferred.await(entered);
        yield* SubscriptionRef.set(state, {
          revision: 1,
          state: {
            ...initial.state,
            projects: [project(0)],
            unreadSessionIds: [CAKE_CHAT_SESSION_ID],
          },
        });
        yield* (yield* SessionCatalogChanges).publish({
          _tag: "CakeChatSessionChanged",
          sessionId: CAKE_CHAT_SESSION_ID,
          resolved: false,
        });
        yield* Deferred.succeed(release, undefined);
        expect(yield* Queue.take(updates)).toMatchObject({
          revision: 1,
          sessions: [{ unread: false }],
        });
        for (let i = 0; i < 2; i++) {
          const update = yield* Queue.take(updates);
          expect(update).toMatchObject({ revision: i + 2 });
          if (update._tag !== "Snapshot") throw new Error("Expected snapshot");
          expect(update.sessions.map((item) => item.sessionId)).toEqual([
            CAKE_CHAT_SESSION_ID,
            projectChatSessionId(project(0).path),
          ]);
          expect(update.sessions[0]?.unread).toBe(true);
        }
        // Initial global scan + two change scans of global and new Project Chat.
        expect(reads).toHaveLength(5);
        expect(subscriptions).toBe(1);
        yield* Fiber.interrupt(observer);
        expect(releases).toBe(1);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
);
