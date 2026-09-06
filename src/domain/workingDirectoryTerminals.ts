import { Effect } from "effect";
import { Terminal, type TerminalWorkingDirectoryTarget } from "../services/terminal/Terminal";

export const open = Effect.fn("WorkingDirectoryTerminals.open")(function* (
  ownerId: number,
  input: {
    readonly requestId: string;
    readonly target: TerminalWorkingDirectoryTarget;
    readonly cols: number;
    readonly rows: number;
  },
) {
  const terminal = yield* Terminal;
  const opened = yield* terminal.open(ownerId, input.target, input.cols, input.rows);
  return { requestId: input.requestId, ...opened };
});

export const write = Effect.fn("WorkingDirectoryTerminals.write")(function* (
  ownerId: number,
  input: { readonly requestId: string; readonly terminalId: string; readonly data: string },
) {
  yield* (yield* Terminal).write(ownerId, input.terminalId, input.data);
  return { requestId: input.requestId };
});

export const resize = Effect.fn("WorkingDirectoryTerminals.resize")(function* (
  ownerId: number,
  input: {
    readonly requestId: string;
    readonly terminalId: string;
    readonly cols: number;
    readonly rows: number;
  },
) {
  yield* (yield* Terminal).resize(ownerId, input.terminalId, input.cols, input.rows);
  return { requestId: input.requestId };
});

export const status = Effect.fn("WorkingDirectoryTerminals.status")(function* (input: {
  readonly requestId: string;
  readonly workingDirectory: string;
}) {
  const runningProgramCount = yield* (yield* Terminal).runningProgramCount(input.workingDirectory);
  return { requestId: input.requestId, runningProgramCount };
});

export const close = Effect.fn("WorkingDirectoryTerminals.close")(function* (
  ownerId: number,
  input: { readonly requestId: string; readonly terminalId: string },
) {
  yield* (yield* Terminal).close(ownerId, input.terminalId);
  return { requestId: input.requestId };
});

export const closeWorkingDirectory = Effect.fn("WorkingDirectoryTerminals.closeWorkingDirectory")(
  function* (input: { readonly requestId: string; readonly workingDirectory: string }) {
    yield* (yield* Terminal).closeWorkingDirectory(input.workingDirectory);
    return { requestId: input.requestId };
  },
);

export const closeOwner = Effect.fn("WorkingDirectoryTerminals.closeOwner")(function* (
  ownerId: number,
) {
  yield* (yield* Terminal).closeOwner(ownerId);
});

export const events = Effect.fn("WorkingDirectoryTerminals.events")(function* (ownerId: number) {
  return (yield* Terminal).events(ownerId);
});
