import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as sessionTerminals from "../../../src/domain/sessionTerminals";
import { Terminal, type TerminalEvent } from "../../../src/services/terminal/Terminal";

const ownerId = 41;
const terminalId = "c73cf0c7-9b47-45fd-8317-211b13fd8e55";

const makeLayer = () => {
  const calls: string[] = [];
  const events: TerminalEvent[] = [
    { type: "terminal-data", terminalId, data: "ready" },
    { type: "terminal-exited", terminalId, exitCode: 0 },
  ];
  const terminal = Terminal.of({
    open: (receivedOwnerId, target, cols, rows) =>
      Effect.sync(() => {
        calls.push(`open:${receivedOwnerId}:${target.kind}:${cols}x${rows}`);
        return { terminalId, shell: "zsh" };
      }),
    write: (receivedOwnerId, receivedTerminalId, data) =>
      Effect.sync(() => calls.push(`write:${receivedOwnerId}:${receivedTerminalId}:${data}`)),
    resize: () => Effect.void,
    hasRunningProgram: () => Effect.succeed(true),
    close: () => Effect.void,
    closeSession: (kind, sessionId) =>
      Effect.sync(() => calls.push(`closeSession:${kind}:${sessionId}`)),
    closeOwner: (receivedOwnerId) => Effect.sync(() => calls.push(`closeOwner:${receivedOwnerId}`)),
    events: (receivedOwnerId) => {
      calls.push(`events:${receivedOwnerId}`);
      return Stream.fromIterable(events);
    },
  });
  return { calls, layer: Layer.succeed(Terminal, terminal) };
};

describe("Session Terminals domain", () => {
  it.effect("associates terminal commands and cleanup with their renderer and Cake Session", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const opened = yield* sessionTerminals.open(ownerId, {
        requestId: "open-request",
        target: { kind: "project", sessionId: "session-1", workspacePath: "/project" },
        cols: 80,
        rows: 24,
      });
      yield* sessionTerminals.write(ownerId, {
        requestId: "write-request",
        terminalId,
        data: "pwd\r",
      });
      const status = yield* sessionTerminals.status(ownerId, {
        requestId: "status-request",
        terminalId,
      });
      yield* sessionTerminals.closeSession("project", "session-1");
      yield* sessionTerminals.closeOwner(ownerId);

      assert.deepEqual(opened, { requestId: "open-request", terminalId, shell: "zsh" });
      assert.deepEqual(status, { requestId: "status-request", runningProgram: true });
      assert.deepEqual(fixture.calls, [
        "open:41:project:80x24",
        `write:41:${terminalId}:pwd\r`,
        "closeSession:project:session-1",
        "closeOwner:41",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("projects only the requested renderer owner's event stream", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const stream = yield* sessionTerminals.events(ownerId);
      const events = yield* Stream.runCollect(stream);
      assert.deepEqual(Array.from(events), [
        { type: "terminal-data", terminalId, data: "ready" },
        { type: "terminal-exited", terminalId, exitCode: 0 },
      ]);
      assert.deepEqual(fixture.calls, ["events:41"]);
    }).pipe(Effect.provide(fixture.layer));
  });
});
