import { realpath } from "node:fs/promises";
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

export interface TerminalLiveOptions {
  readonly homeDirectory: string;
}

const terminalError = (operation: string, cause: unknown) =>
  new TerminalError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export const makeTerminalLive = ({ homeDirectory }: TerminalLiveOptions) =>
  Layer.effect(
    Terminal,
    Effect.gen(function* () {
      const access = yield* ProjectAccess;
      const resolveWorkingDirectory = Effect.fn("Terminal.resolveWorkingDirectory")(
        function* (target) {
          if (target.kind === "cake-chat") return homeDirectory;
          if (!(yield* access.isAllowed(target.workspacePath)))
            return yield* new TerminalError({
              operation: "Terminal.resolveWorkingDirectory",
              message: "Project path was not selected by the user",
            });
          return yield* Effect.tryPromise({
            try: () => realpath(target.workspacePath),
            catch: (cause) => terminalError("Terminal.resolveWorkingDirectory", cause),
          });
        },
      );
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
          const cwd = yield* resolveWorkingDirectory(target);
          return yield* attempt("Terminal.spawn", () =>
            manager.open(
              ownerId,
              { kind: target.kind, sessionId: target.sessionId },
              cwd,
              cols,
              rows,
            ),
          );
        }),
        write: Effect.fn("Terminal.write")((ownerId, terminalId, data) =>
          attempt("Terminal.processWrite", () => manager.write(ownerId, terminalId, data)),
        ),
        resize: Effect.fn("Terminal.resize")((ownerId, terminalId, cols, rows) =>
          attempt("Terminal.processResize", () => manager.resize(ownerId, terminalId, cols, rows)),
        ),
        hasRunningProgram: Effect.fn("Terminal.hasRunningProgram")((ownerId, terminalId) =>
          attempt("Terminal.inspectProcess", () => manager.hasRunningProgram(ownerId, terminalId)),
        ),
        close: Effect.fn("Terminal.close")((ownerId, terminalId) =>
          attempt("Terminal.processClose", () => manager.close(ownerId, terminalId)),
        ),
        closeSession: Effect.fn("Terminal.closeSession")((kind, sessionId) =>
          attempt("Terminal.processCloseSession", () => manager.closeSession(kind, sessionId)),
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
