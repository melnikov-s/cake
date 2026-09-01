import { Context, Schema, type Effect, type Stream } from "effect";

export class TerminalError extends Schema.TaggedError<TerminalError>()("TerminalError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type TerminalSessionKind = "project" | "cake-chat";

export type TerminalSessionTarget =
  | { readonly kind: "project"; readonly sessionId: string; readonly workspacePath: string }
  | { readonly kind: "cake-chat"; readonly sessionId: string };

export type TerminalEvent =
  | { readonly type: "terminal-data"; readonly terminalId: string; readonly data: string }
  | { readonly type: "terminal-exited"; readonly terminalId: string; readonly exitCode: number };

export interface TerminalService {
  readonly open: (
    ownerId: number,
    target: TerminalSessionTarget,
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
  readonly hasRunningProgram: (
    ownerId: number,
    terminalId: string,
  ) => Effect.Effect<boolean, TerminalError>;
  readonly close: (ownerId: number, terminalId: string) => Effect.Effect<void, TerminalError>;
  readonly closeSession: (
    kind: TerminalSessionKind,
    sessionId: string,
  ) => Effect.Effect<void, TerminalError>;
  readonly closeOwner: (ownerId: number) => Effect.Effect<void, TerminalError>;
  readonly events: (ownerId: number) => Stream.Stream<TerminalEvent>;
}

/** Process-scoped owner of Cake pseudo terminals and their output streams. */
export class Terminal extends Context.Service<Terminal, TerminalService>()(
  "cake/services/terminal/Terminal",
) {}
