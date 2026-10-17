import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { makeSessionCoordinationStorageLive } from "../../../src/services/storage/SessionCoordinationStorage";

export const coordinationStorageHarness = (files = new Map<string, string>()) => {
  const failure = () =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "SessionCoordinationStorageTest",
      method: "read",
    });
  const fs = FileSystem.makeNoop({
    exists: (path) =>
      Effect.succeed(
        files.has(path) || [...files.keys()].some((file) => file.startsWith(`${path}/`)),
      ),
    readDirectory: (path) =>
      Effect.succeed([
        ...new Set(
          [...files.keys()]
            .filter((file) => file.startsWith(`${path}/`))
            .map((file) => file.slice(path.length + 1).split("/")[0] ?? ""),
        ),
      ]),
    readFileString: (path) => {
      const content = files.get(path);
      return content === undefined ? Effect.fail(failure()) : Effect.succeed(content);
    },
    writeFileString: (path, content) => Effect.sync(() => files.set(path, content)),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    rename: (source, target) =>
      Effect.gen(function* () {
        const content = files.get(source);
        if (content === undefined) return yield* Effect.fail(failure());
        files.set(target, content);
        files.delete(source);
      }),
    remove: (path) => Effect.sync(() => files.delete(path)),
  });
  return {
    files,
    platform: Layer.merge(Layer.succeed(FileSystem.FileSystem, fs), Path.layer),
    layer: makeSessionCoordinationStorageLive("state/session-coordination.json").pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Path.layer),
    ),
  };
};
