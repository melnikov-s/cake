import { Effect } from "effect";
import type { FileSystem, Path } from "effect";

export type AtomicFileStage = "write" | "rename";

/** Ensures the target's directory, writes beside the target, atomically
 *  replaces it, and always removes leftovers. */
export const atomicWriteFile = Effect.fn("atomicWriteFile")(function* <E>(
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  content: string,
  onError: (stage: AtomicFileStage, cause: unknown) => E,
) {
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;

  // Storage directories under CakePaths are not created anywhere else, so a
  // first write on a fresh machine is what brings them into existence.
  yield* fileSystem
    .makeDirectory(path.dirname(target), { recursive: true })
    .pipe(Effect.mapError((cause) => onError("write", cause)));

  return yield* Effect.acquireUseRelease(
    Effect.succeed(temporary),
    (file) =>
      fileSystem.writeFileString(file, content, { mode: 0o600 }).pipe(
        Effect.mapError((cause) => onError("write", cause)),
        Effect.flatMap(() => fileSystem.chmod(file, 0o600)),
        Effect.mapError((cause) => onError("write", cause)),
        Effect.flatMap(() =>
          fileSystem
            .rename(file, target)
            .pipe(Effect.mapError((cause) => onError("rename", cause))),
        ),
      ),
    (file) => fileSystem.remove(file, { force: true }).pipe(Effect.ignore),
  ).pipe(
    Effect.annotateLogs({ target: path.basename(target) }),
    Effect.withSpan("atomicWriteFile"),
  );
});
