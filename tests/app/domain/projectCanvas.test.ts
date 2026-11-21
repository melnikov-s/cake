import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, FileSystem, Fiber, Layer, Queue, Stream } from "effect";
import { expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { parseCanvasLink } from "../../../src/contracts/project-canvas/canvas-link";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as canvas from "../../../src/domain/project-canvas/projectCanvas";
import {
  makeProjectCanvasControl,
  createProjectCanvasOperations,
} from "../../../src/domain/project-canvas/project-canvas-operations";
import { makeProjectCanvasStorageLive } from "../../../src/services/storage/ProjectCanvasStorage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { fakeApplicationState } from "../../helpers/fakes/applicationState";
import { fakeTaskInputStorage } from "../../helpers/fakes/taskInputStorage";
import { fakeSessionFamilyStorage } from "../../helpers/fakes/sessionFamilyStorage";

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const projectPaths = ["/project/canvas-a", "/project/canvas-b"];
const [id, other] = projectPaths.map(projectChatSessionId);
const publisher = "canvas-publishing-session";
const app = fakeApplicationState(
  {},
  {
    ...defaultApplicationState(),
    projects: projectPaths.map((path) => ({ path, name: path, addedAt: "", lastOpenedAt: "" })),
  },
);

it.effect(
  "publishes through typed controls, observes committed snapshots, and retains exact pins after restart",
  () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const storage = () =>
        Layer.mergeAll(
          makeProjectCanvasStorageLive(dir).pipe(Layer.provide(platform)),
          app,
          Layer.mock(ArtifactStorage, {}),
          fakeTaskInputStorage(),
          fakeSessionFamilyStorage(),
        );
      const first = yield* Effect.gen(function* () {
        const context = yield* Effect.context<Effect.Services<ReturnType<typeof canvas.publish>>>();
        const control = makeProjectCanvasControl(id!, publisher, Effect.runPromiseWith(context));
        expect(createProjectCanvasOperations(control).map((op) => op.command)).toEqual([
          "canvas.publish",
          "canvas.search",
          "canvas.read",
        ]);
        const snapshots = yield* Queue.unbounded<boolean>();
        const stream = yield* canvas.observe(id!).pipe(
          Stream.runForEach((state) => Queue.offer(snapshots, state.cards.length > 0)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(snapshots)).toBe(false);
        const publish = Effect.fn("Test.publish")(function* () {
          return yield* canvas.publish(id!, publisher, {
            group: "Checkout review",
            title: "Before",
            content: { kind: "decision", text: "Keep guest checkout" },
          });
        });
        const first = yield* publish();
        expect(yield* Queue.take(snapshots)).toBe(true);
        yield* Fiber.interrupt(stream);
        expect(parseCanvasLink(first.link)).toEqual({
          projectChatId: id,
          cardId: first.cardId,
          revision: 1,
        });
        expect(
          (yield* canvas.search(id!, { query: "guest" })).items.map((hit) => hit.link),
        ).toEqual([first.link]);
        expect((yield* canvas.read(id!, first.link)).revision.publisher).toBe(publisher);
        const pin = yield* canvas.pin(id!, {
          link: first.link,
          x: 0.25,
          y: 0.6,
          text: "Move this closer",
        });
        const publishNext = canvas.publish(id!, id!, {
          previous: first.link,
          group: first.group,
          title: "After",
          content: { kind: "decision", text: "Guest moved" },
        });
        const revisions = yield* Effect.all(
          [Effect.result(publishNext), Effect.result(publishNext)],
          { concurrency: "unbounded" },
        );
        expect(revisions.map((value) => value._tag).sort()).toEqual(["Failure", "Success"]);
        expect(yield* Effect.result(canvas.read(other!, first.link))).toMatchObject({
          _tag: "Failure",
        });
        expect(
          yield* Effect.result(
            canvas.pin(other!, { link: first.link, x: 0.5, y: 0.5, text: "No" }),
          ),
        ).toMatchObject({ _tag: "Failure" });
        expect(yield* Effect.result(canvas.search(CAKE_CHAT_SESSION_ID, {}))).toMatchObject({
          _tag: "Failure",
        });
        return { ...first, pin };
      }).pipe(Effect.scoped, Effect.provide(storage()));
      yield* Effect.gen(function* () {
        const exact = yield* canvas.read(id!, first.link);
        expect(exact.revision).toMatchObject({ title: "Before", number: 1, pins: [first.pin] });
        expect(exact.history.map((revision) => [revision.number, revision.publisher])).toEqual([
          [1, publisher],
          [2, id],
        ]);
        expect((yield* canvas.read(id!, first.stableLink)).revision).toMatchObject({
          title: "After",
          number: 2,
          pins: [],
        });
        expect((yield* canvas.search(other!, {})).items).toEqual([]);
        expect((yield* canvas.search(id!, { query: "closer" })).items[0]?.link).toBe(first.link);
      }).pipe(Effect.provide(storage()));
    }).pipe(Effect.provide(platform)),
);
