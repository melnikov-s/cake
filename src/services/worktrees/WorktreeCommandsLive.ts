import { DateTime, Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  WorktreeCommandError,
  WorktreeCommands,
  type WorktreeCommandRequest,
} from "./WorktreeCommands";

const TAIL_BYTES = 4_096;
const MESSAGE_TAIL_CHARACTERS = 2_000;

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const logFileName = (name: string) => `${name.replace(/[^A-Za-z0-9._-]+/g, "-") || "worktree"}.log`;

/** Real `/bin/sh` runner. Logs live in `logDirectory`, one appended file per worktree name. */
export const makeWorktreeCommandsLive = (
  logDirectory: string,
): Layer.Layer<
  WorktreeCommands,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
  Layer.effect(
    WorktreeCommands,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const tail = Effect.fn("WorktreeCommands.tail")(function* (logPath: string) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fileSystem.open(logPath, { flag: "r" });
            const size = (yield* file.stat).size;
            const limit = BigInt(TAIL_BYTES);
            yield* file.seek(size > limit ? size - limit : 0n, "start");
            const bytes = yield* file.readAlloc(TAIL_BYTES);
            return Option.match(bytes, {
              onNone: () => "",
              onSome: (value) => new TextDecoder().decode(value),
            });
          }),
        ).pipe(Effect.orElseSucceed(() => ""));
      });

      const run = Effect.fn("WorktreeCommands.run")(function* (request: WorktreeCommandRequest) {
        const logPath = path.join(logDirectory, logFileName(request.logName));
        const fail = (reason: WorktreeCommandError["reason"], summary: string) =>
          Effect.gen(function* () {
            const output = (yield* tail(logPath)).trim().slice(-MESSAGE_TAIL_CHARACTERS);
            return yield* new WorktreeCommandError({
              label: request.label,
              reason,
              logPath,
              message: [
                `The worktree ${request.label} command ${summary}.`,
                output && `Last output:\n${output}`,
                `Full log: ${logPath}`,
              ]
                .filter(Boolean)
                .join("\n"),
            });
          });
        const note = (line: string) =>
          fileSystem
            .writeFileString(logPath, `${line}\n`, { flag: "a" })
            .pipe(Effect.orElseSucceed(() => undefined));
        yield* fileSystem
          .makeDirectory(logDirectory, { recursive: true })
          .pipe(Effect.catch((cause) => fail("start", `could not start: ${messageOf(cause)}`)));
        yield* note(
          `\n# ${DateTime.formatIso(yield* DateTime.now)} ${request.label} in ${request.workingDirectory}`,
        );
        // The shell redirects its own output into the log, so no pipe can fill and stall the
        // script, and stdin is /dev/null so a prompting tool fails instead of waiting forever.
        const script = [`exec >>${shellQuote(logPath)} 2>&1`, "set -e", request.script].join("\n");
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make("/bin/sh", ["-c", script], {
                cwd: request.workingDirectory,
                stdin: "ignore",
                stdout: "ignore",
                stderr: "ignore",
                forceKillAfter: "5 seconds",
              }),
            );
            // Closing this scope on timeout terminates the script's whole process group.
            return request.timeout === undefined
              ? Option.some(yield* handle.exitCode)
              : yield* handle.exitCode.pipe(Effect.timeoutOption(request.timeout));
          }),
        ).pipe(
          Effect.catch((cause) =>
            fail("start", `could not run to completion: ${messageOf(cause)}`),
          ),
        );
        if (Option.isNone(exit)) {
          yield* note(`# ${request.label} timed out`);
          return yield* fail("timeout", "timed out and was stopped");
        }
        yield* note(`# ${request.label} exited with ${exit.value}`);
        if (exit.value !== 0) return yield* fail("exit", `failed with exit code ${exit.value}`);
      });

      return WorktreeCommands.of({ run });
    }),
  );
