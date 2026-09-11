import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { makeSessionFamilyStorageLive } from "../../../src/services/storage/SessionFamilyStorage";
const failure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "SessionFamilyStorageTest", method });

export const familyStorageHarness = (initialFiles = new Map<string, string>()) => {
  const files = initialFiles;
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      const value = files.get(path);
      return value === undefined ? Effect.fail(failure("readFileString")) : Effect.succeed(value);
    },
    writeFileString: (path, content) => Effect.sync(() => files.set(path, content)),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    rename: (source, target) =>
      Effect.gen(function* () {
        const value = files.get(source);
        if (value === undefined) return yield* Effect.fail(failure("rename"));
        files.set(target, value);
        files.delete(source);
      }),
    remove: (path) => Effect.sync(() => files.delete(path)),
  });
  const layer = makeSessionFamilyStorageLive("state/session-families.json").pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
    Layer.provide(Path.layer),
  );
  return { files, layer };
};
