import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Effect, Layer, PubSub, Stream } from "effect";
import { ProjectAccess } from "../projects/ProjectAccess";
import { Terminal, TerminalError } from "./Terminal";
import { TerminalManager } from "./TerminalManager";

type OwnedTerminalEvent =
  | {
      readonly type: "terminal-data";
      readonly ownerId: number;
      readonly terminalId: string;
      readonly data: string;
    }
  | {
      readonly type: "terminal-exited";
      readonly ownerId: number;
      readonly terminalId: string;
      readonly exitCode: number;
    };

const terminalError = (operation: string, cause: unknown) =>
  new TerminalError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeTerminalLive = () =>
  Layer.effect(
    Terminal,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      // Resource identities, retained for cleanup even after a checkout or symlink disappears.
      const workingDirectoryIdentities = new Map<string, string>();
      // Per-resource invalidation: a close wins over any already-started asynchronous open.
      const closedAt = new Map<string, number>();
      let closeRevision = 0;
      const knownWorkingDirectory = (workingDirectory: string) =>
        workingDirectoryIdentities.get(resolve(workingDirectory)) ?? resolve(workingDirectory);
      const requireAllowed = Effect.fn("Terminal.requireAllowed")(function* (
        workingDirectory: string,
      ) {
        if (!(yield* access.isAllowed(workingDirectory)))
          return yield* new TerminalError({
            operation: "Terminal.resolveWorkingDirectory",
            message: "Project path was not selected by the user",
          });
      });
      const resolveWorkingDirectory = Effect.fn("Terminal.resolveWorkingDirectory")(function* (
        workingDirectory: string,
      ) {
        yield* requireAllowed(workingDirectory);
        return yield* Effect.tryPromise({
          try: () => realpath(workingDirectory),
          catch: (cause) => terminalError("Terminal.resolveWorkingDirectory", cause),
        });
      });
      const events = yield* Effect.acquireRelease(
        PubSub.unbounded<OwnedTerminalEvent>(),
        PubSub.shutdown,
      );
      const manager = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new TerminalManager((event) => {
              const projected: OwnedTerminalEvent =
                event.type === "data"
                  ? {
                      type: "terminal-data",
                      ownerId: event.ownerId,
                      terminalId: event.terminalId,
                      data: event.data,
                    }
                  : {
                      type: "terminal-exited",
                      ownerId: event.ownerId,
                      terminalId: event.terminalId,
                      exitCode: event.exitCode,
                    };
              PubSub.publishUnsafe(events, projected);
            }),
        ),
        (manager) => Effect.sync(() => manager.disposeAll()),
      );

      const attempt = <A>(name: string, evaluate: () => A) =>
        Effect.try({ try: evaluate, catch: (cause) => terminalError(name, cause) }).pipe(
          Effect.withSpan(name),
        );

      return Terminal.of({
        open: Effect.fn("Terminal.open")(function* (ownerId, target, cols, rows) {
          const startedAt = closeRevision;
          const requestedDirectory = resolve(target.workingDirectory);
          const workingDirectory = yield* resolveWorkingDirectory(target.workingDirectory);
          return yield* attempt("Terminal.spawn", () => {
            if (
              (closedAt.get(requestedDirectory) ?? 0) > startedAt ||
              (closedAt.get(workingDirectory) ?? 0) > startedAt
            )
              throw new Error("Working Directory terminals were closed while opening");
            const opened = manager.open(ownerId, workingDirectory, cols, rows);
            workingDirectoryIdentities.set(resolve(target.workingDirectory), workingDirectory);
            return opened;
          });
        }),
        write: Effect.fn("Terminal.write")((ownerId, terminalId, data) =>
          attempt("Terminal.processWrite", () => manager.write(ownerId, terminalId, data)),
        ),
        resize: Effect.fn("Terminal.resize")((ownerId, terminalId, cols, rows) =>
          attempt("Terminal.processResize", () => manager.resize(ownerId, terminalId, cols, rows)),
        ),
        runningProgramCount: Effect.fn("Terminal.runningProgramCount")(
          function* (workingDirectory) {
            yield* requireAllowed(workingDirectory);
            return yield* attempt("Terminal.inspectProcesses", () =>
              manager.runningProgramCount(knownWorkingDirectory(workingDirectory)),
            );
          },
        ),
        close: Effect.fn("Terminal.close")((ownerId, terminalId) =>
          attempt("Terminal.processClose", () => manager.close(ownerId, terminalId)),
        ),
        closeWorkingDirectory: Effect.fn("Terminal.closeWorkingDirectory")(
          function* (workingDirectory) {
            yield* requireAllowed(workingDirectory);
            const canonicalWorkingDirectory = knownWorkingDirectory(workingDirectory);
            yield* attempt("Terminal.processCloseWorkingDirectory", () => {
              closeRevision += 1;
              closedAt.set(resolve(workingDirectory), closeRevision);
              closedAt.set(canonicalWorkingDirectory, closeRevision);
              manager.closeWorkingDirectory(canonicalWorkingDirectory);
            });
          },
        ),
        closeOwner: Effect.fn("Terminal.closeOwner")((ownerId) =>
          attempt("Terminal.processCloseOwner", () => manager.closeOwner(ownerId)),
        ),
        events: (ownerId) =>
          Stream.fromPubSub(events).pipe(
            Stream.filter((event) => event.ownerId === ownerId),
            Stream.map((event) =>
              event.type === "terminal-data"
                ? {
                    type: event.type,
                    terminalId: event.terminalId,
                    data: event.data,
                  }
                : {
                    type: event.type,
                    terminalId: event.terminalId,
                    exitCode: event.exitCode,
                  },
            ),
          ),
      });
    }),
  );
