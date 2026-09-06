import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as workingDirectoryTerminals from "../../../src/domain/workingDirectoryTerminals";
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
        calls.push(`open:${receivedOwnerId}:${target.workingDirectory}:${cols}x${rows}`);
        return { terminalId, shell: "zsh" };
      }),
    write: (receivedOwnerId, receivedTerminalId, data) =>
      Effect.sync(() => calls.push(`write:${receivedOwnerId}:${receivedTerminalId}:${data}`)),
    resize: () => Effect.void,
    runningProgramCount: () => Effect.succeed(2),
    close: () => Effect.void,
    closeWorkingDirectory: (workingDirectory) =>
      Effect.sync(() => calls.push(`closeWorkingDirectory:${workingDirectory}`)),
    closeOwner: (receivedOwnerId) => Effect.sync(() => calls.push(`closeOwner:${receivedOwnerId}`)),
    events: (receivedOwnerId) => {
      calls.push(`events:${receivedOwnerId}`);
      return Stream.fromIterable(events);
    },
  });
  return { calls, layer: Layer.succeed(Terminal, terminal) };
};

describe("Working Directory terminals domain", () => {
  it.effect("associates terminal commands with their renderer and Working Directory", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const opened = yield* workingDirectoryTerminals.open(ownerId, {
        requestId: "open-request",
        target: { workingDirectory: "/project" },
        cols: 80,
        rows: 24,
      });
      yield* workingDirectoryTerminals.write(ownerId, {
        requestId: "write-request",
        terminalId,
        data: "pwd\r",
      });
      const status = yield* workingDirectoryTerminals.status({
        requestId: "status-request",
        workingDirectory: "/project",
      });
      yield* workingDirectoryTerminals.closeWorkingDirectory({
        requestId: "close-directory-request",
        workingDirectory: "/project",
      });
      yield* workingDirectoryTerminals.closeOwner(ownerId);

      assert.deepEqual(opened, { requestId: "open-request", terminalId, shell: "zsh" });
      assert.deepEqual(status, { requestId: "status-request", runningProgramCount: 2 });
      assert.deepEqual(fixture.calls, [
        "open:41:/project:80x24",
        `write:41:${terminalId}:pwd\r`,
        "closeWorkingDirectory:/project",
        "closeOwner:41",
      ]);
    }).pipe(Effect.provide(fixture.layer));
  });

  it.effect("projects only the requested renderer owner's event stream", () => {
    const fixture = makeLayer();
    return Effect.gen(function* () {
      const stream = yield* workingDirectoryTerminals.events(ownerId);
      const events = yield* Stream.runCollect(stream);
      assert.deepEqual(Array.from(events), [
        { type: "terminal-data", terminalId, data: "ready" },
        { type: "terminal-exited", terminalId, exitCode: 0 },
      ]);
      assert.deepEqual(fixture.calls, ["events:41"]);
    }).pipe(Effect.provide(fixture.layer));
  });
});
