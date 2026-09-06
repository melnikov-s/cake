import { Context, Schema, type Effect, type Stream } from "effect";

export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface TerminalWorkingDirectoryTarget {
  readonly workingDirectory: string;
}

export type TerminalEvent =
  | { readonly type: "terminal-data"; readonly terminalId: string; readonly data: string }
  | { readonly type: "terminal-exited"; readonly terminalId: string; readonly exitCode: number };

export interface TerminalService {
  readonly open: (
    ownerId: number,
    target: TerminalWorkingDirectoryTarget,
    cols: number,
    rows: number,
  ) => Effect.Effect<{ readonly terminalId: string; readonly shell: string }, TerminalError>;
  readonly write: (
    ownerId: number,
    terminalId: string,
    data: string,
  ) => Effect.Effect<void, TerminalError>;
  readonly resize: (
    ownerId: number,
    terminalId: string,
    cols: number,
    rows: number,
  ) => Effect.Effect<void, TerminalError>;
  readonly runningProgramCount: (workingDirectory: string) => Effect.Effect<number, TerminalError>;
  readonly close: (ownerId: number, terminalId: string) => Effect.Effect<void, TerminalError>;
  readonly closeWorkingDirectory: (workingDirectory: string) => Effect.Effect<void, TerminalError>;
  readonly closeOwner: (ownerId: number) => Effect.Effect<void, TerminalError>;
  readonly events: (ownerId: number) => Stream.Stream<TerminalEvent>;
}

/** Process-scoped owner of Cake pseudo terminals and their output streams. */
export class Terminal extends Context.Service<Terminal, TerminalService>()(
  "cake/services/terminal/Terminal",
) {}
