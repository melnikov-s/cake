import { Effect } from "effect";
import {
  Terminal,
  type TerminalSessionKind,
  type TerminalSessionTarget,
} from "../services/terminal/Terminal";

export const open = Effect.fn("SessionTerminals.open")(function* (
  ownerId: number,
  input: {
    readonly requestId: string;
    readonly target: TerminalSessionTarget;
    readonly cols: number;
    readonly rows: number;
  },
) {
  const terminal = yield* Terminal;
  const opened = yield* terminal.open(ownerId, input.target, input.cols, input.rows);
  return { requestId: input.requestId, ...opened };
});

export const write = Effect.fn("SessionTerminals.write")(function* (
  ownerId: number,
  input: { readonly requestId: string; readonly terminalId: string; readonly data: string },
) {
  yield* (yield* Terminal).write(ownerId, input.terminalId, input.data);
  return { requestId: input.requestId };
});

export const resize = Effect.fn("SessionTerminals.resize")(function* (
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

export const status = Effect.fn("SessionTerminals.status")(function* (
  ownerId: number,
  input: { readonly requestId: string; readonly terminalId: string },
) {
  const runningProgram = yield* (yield* Terminal).hasRunningProgram(ownerId, input.terminalId);
  return { requestId: input.requestId, runningProgram };
});

export const close = Effect.fn("SessionTerminals.close")(function* (
  ownerId: number,
  input: { readonly requestId: string; readonly terminalId: string },
) {
  yield* (yield* Terminal).close(ownerId, input.terminalId);
  return { requestId: input.requestId };
});

export const closeSession = Effect.fn("SessionTerminals.closeSession")(function* (
  kind: TerminalSessionKind,
  sessionId: string,
) {
  yield* (yield* Terminal).closeSession(kind, sessionId);
});

export const closeOwner = Effect.fn("SessionTerminals.closeOwner")(function* (ownerId: number) {
  yield* (yield* Terminal).closeOwner(ownerId);
});

export const events = Effect.fn("SessionTerminals.events")(function* (ownerId: number) {
  return (yield* Terminal).events(ownerId);
});
