import { Effect, Option, Path, Stream, type PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  ArtifactCommandError,
  type ArtifactShellInput,
} from "../../contracts/artifacts/artifact-commands";

// Match the normal Pi tool output byte bound, independently for stdout and stderr.
const OUTPUT_BYTES = 50 * 1024;

/** A single invocation owns its process scope; no renderer or agent runtime is involved. */
export const run = Effect.fn("ArtifactShell.run")(function* (input: ArtifactShellInput) {
  const path = yield* Path.Path;
  if (!path.isAbsolute(input.cwd))
    return yield* new ArtifactCommandError({
      command: "shell.run",
      message: "cwd must be an absolute backend-host path.",
    });
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const capture = () => {
    const bytes = new Uint8Array(OUTPUT_BYTES);
    let size = 0;
    let truncated = false;
    return {
      drain: (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
        Stream.runForEach(stream, (chunk) =>
          Effect.sync(() => {
            const count = Math.min(chunk.byteLength, OUTPUT_BYTES - size);
            bytes.set(chunk.subarray(0, count), size);
            size += count;
            truncated ||= count < chunk.byteLength;
          }),
        ),
      result: () => ({ text: new TextDecoder().decode(bytes.subarray(0, size)), truncated }),
    };
  };
  const stdout = capture();
  const stderr = capture();
  const exit = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(input.command, {
          shell: true,
          cwd: input.cwd,
          env: input.env,
          extendEnv: true,
          stdin: "ignore",
          forceKillAfter: "5 seconds",
        }),
      );
      // The platform finalizer skips successful exited shells. Still clean their remaining
      // process group (e.g. `sleep 60 & exit 0`), including children that ignore SIGTERM.
      yield* Effect.addFinalizer(() =>
        handle
          .kill({ forceKillAfter: "5 seconds" })
          .pipe(
            Effect.ensuring(handle.kill({ killSignal: "SIGKILL" }).pipe(Effect.ignore)),
            Effect.ignore,
          ),
      );
      // Keep draining after the retained prefix is full so a verbose CLI cannot block on its pipes.
      const completion = Effect.all(
        [handle.exitCode, stdout.drain(handle.stdout), stderr.drain(handle.stderr)],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([exitCode]) => exitCode));
      return input.timeoutSeconds === undefined
        ? Option.some(yield* completion)
        : yield* completion.pipe(Effect.timeoutOption(input.timeoutSeconds * 1000));
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ArtifactCommandError({
          command: "shell.run",
          message: cause.message,
        }),
    ),
  );
  const out = stdout.result();
  const err = stderr.result();
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: Option.isSome(exit) ? Number(exit.value) : null,
    timedOut: Option.isNone(exit),
    stdoutTruncated: out.truncated,
    stderrTruncated: err.truncated,
  };
});
