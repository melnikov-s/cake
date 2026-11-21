import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  PubSub,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import { CanvasSnapshot, ProjectCanvasError } from "../../contracts/project-canvas/project-canvas";
import { atomicWriteFile } from "./internal/atomicFile";

type Update<A> = (
  board: CanvasSnapshot,
) => Effect.Effect<{ board: CanvasSnapshot; result: A }, ProjectCanvasError>;
export class ProjectCanvasStorage extends Context.Service<
  ProjectCanvasStorage,
  {
    readonly load: (projectChatId: string) => Effect.Effect<CanvasSnapshot, ProjectCanvasError>;
    readonly update: <A>(
      projectChatId: string,
      change: Update<A>,
    ) => Effect.Effect<A, ProjectCanvasError>;
    readonly observe: (projectChatId: string) => Stream.Stream<CanvasSnapshot, ProjectCanvasError>;
  }
>()("cake/services/storage/ProjectCanvasStorage") {}

const codec = Schema.fromJsonString(CanvasSnapshot);
const storageError = (operation: string, cause: unknown) =>
  new ProjectCanvasError({
    message: `Canvas ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

export const makeProjectCanvasStorageLive = (root: string) =>
  Layer.effect(
    ProjectCanvasStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const updates = yield* PubSub.sliding<string>(64);
      const file = (id: string) =>
        path.join(root, "project-canvases", `${encodeURIComponent(id)}.json`);
      const load = Effect.fn("ProjectCanvasStorage.load")(function* (projectChatId: string) {
        const target = file(projectChatId);
        const exists = yield* fs
          .exists(target)
          .pipe(Effect.mapError((error) => storageError("load", error)));
        if (!exists) return { version: 1 as const, cards: [] };
        const content = yield* fs
          .readFileString(target)
          .pipe(Effect.mapError((error) => storageError("load", error)));
        return yield* Schema.decodeUnknownEffect(codec)(content).pipe(
          Effect.mapError((error) => storageError("decode", error)),
        );
      });
      const update = Effect.fn("ProjectCanvasStorage.update")(<A>(id: string, change: Update<A>) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const { board, result } = yield* change(yield* load(id));
            const content = yield* Schema.encodeEffect(codec)(board).pipe(
              Effect.mapError((error) => storageError("encode", error)),
            );
            yield* Effect.uninterruptible(
              atomicWriteFile(fs, path, file(id), content, storageError).pipe(
                Effect.andThen(PubSub.publish(updates, id)),
              ),
            );
            return result;
          }),
        ),
      );
      // Subscribe before the first disk read. Updates are invalidations, not a history log;
      // coalescing is safe because each emission rereads the current committed snapshot.
      const observe = (id: string) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* PubSub.subscribe(updates);
            // Reload on all invalidations so sliding cannot drop the only notification for this project.
            return Stream.concat(
              Stream.fromEffect(load(id)),
              Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => load(id))),
            );
          }),
        );
      return ProjectCanvasStorage.of({ load, update, observe });
    }),
  );
