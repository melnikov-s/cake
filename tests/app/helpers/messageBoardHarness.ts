import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import { makeMessageBoardStorageLive } from "../../../src/services/storage/MessageBoardStorageLive";

/** Real storage policy with a deterministic in-memory filesystem boundary. */
export const messageBoardHarness = (files = new Map<string, string>()) => {
  const directories = new Set<string>();
  const fail = (method: string) =>
    PlatformError.systemError({ _tag: "NotFound", module: "MessageBoardTest", method });
  const fs = FileSystem.makeNoop({
    exists: (target) =>
      Effect.succeed(
        files.has(target) ||
          directories.has(target) ||
          [...files.keys()].some((key) => key.startsWith(`${target}/`)),
      ),
    readFileString: (target) =>
      files.has(target) ? Effect.succeed(files.get(target) ?? "") : Effect.fail(fail("read")),
    writeFileString: (target, content) =>
      Effect.sync(() => {
        files.set(target, content);
      }),
    makeDirectory: (target) =>
      Effect.sync(() => {
        directories.add(target);
      }),
    chmod: () => Effect.void,
    readDirectory: (target) =>
      Effect.succeed([
        ...new Set(
          [...files.keys()]
            .filter((key) => key.startsWith(`${target}/`))
            .map((key) => key.slice(target.length + 1).split("/")[0] ?? ""),
        ),
      ]),
    rename: (source, target) =>
      Effect.gen(function* () {
        const text = files.get(source);
        if (text === undefined) return yield* Effect.fail(fail("rename"));
        files.set(target, text);
        files.delete(source);
      }),
    remove: (target) =>
      Effect.sync(() => {
        for (const key of files.keys())
          if (key === target || key.startsWith(`${target}/`)) files.delete(key);
        directories.delete(target);
      }),
  });
  const platform = Layer.merge(Layer.succeed(FileSystem.FileSystem, fs), Path.layer);
  const layer = Layer.merge(
    makeArtifactStorageLive("/artifacts"),
    makeMessageBoardStorageLive("/artifacts"),
  ).pipe(Layer.provide(platform));
  return { files, layer };
};
