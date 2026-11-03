import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect";
import { makeSessionFamilyStorageLive } from "../../../src/services/storage/SessionFamilyStorage";
const failure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "SessionFamilyStorageTest", method });

export const familyStorageHarness = (initialFiles = new Map<string, string>()) => {
  const files = initialFiles;
  // Any content change, including a test's direct `files.set`, yields a new modification time.
  const revisions = new Map<string, { readonly content: string; readonly revision: number }>();
  let clock = 0;
  let reads = 0;
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      reads++;
      const value = files.get(path);
      return value === undefined ? Effect.fail(failure("readFileString")) : Effect.succeed(value);
    },
    stat: (path) => {
      const content = files.get(path);
      if (content === undefined) return Effect.fail(failure("stat"));
      if (revisions.get(path)?.content !== content)
        revisions.set(path, { content, revision: ++clock });
      return Effect.succeed({
        type: "File",
        ino: Option.none(),
        size: FileSystem.Size(content.length),
        mtime: Option.some(new Date(revisions.get(path)?.revision ?? 0)),
      } as FileSystem.File.Info);
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
  return { files, layer, reads: () => reads };
};
