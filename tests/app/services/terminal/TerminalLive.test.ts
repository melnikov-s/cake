import { basename } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { beforeEach, describe, expect, vi } from "vitest";
import { ProjectAccess } from "../../../../src/services/projects/ProjectAccess";
import { Terminal } from "../../../../src/services/terminal/Terminal";
import { makeTerminalLive } from "../../../../src/services/terminal/TerminalLive";

const native = vi.hoisted(() => ({
  realpath: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ realpath: native.realpath }));
vi.mock("node-pty", () => ({ spawn: native.spawn }));

const processes: Array<{
  process: string;
  kill: ReturnType<typeof vi.fn>;
  emitData(data: string): void;
}> = [];

beforeEach(() => {
  processes.length = 0;
  native.realpath
    .mockReset()
    .mockImplementation(async (path: string) => (path === "/alias" ? "/canonical" : path));
  native.spawn.mockReset().mockImplementation((shell: string) => {
    let dataListener: ((data: string) => void) | undefined;
    const process = {
      process: basename(shell),
      kill: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      onData: vi.fn((listener: (data: string) => void) => {
        dataListener = listener;
      }),
      emitData(data: string) {
        dataListener?.(data);
      },
      onExit: vi.fn(),
    };
    processes.push(process);
    return process;
  });
});

const layer = () =>
  makeTerminalLive().pipe(
    Layer.provide(
      Layer.mock(ProjectAccess, {
        isAllowed: (directory) => Effect.succeed(directory !== "/forbidden"),
      }),
    ),
  );

describe("TerminalLive retirement", () => {
  it.effect("subscribes to PTY output before advertising terminal readiness", () =>
    Effect.gen(function* () {
      const terminal = yield* Terminal;
      const messages = yield* Stream.runCollect(
        terminal.events(1).pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              if (event.type !== "renderer-events-ready") return event;
              const opened = yield* terminal.open(1, { workingDirectory: "/canonical" }, 80, 24);
              const pty = processes[0];
              if (!pty) throw new Error("Expected a PTY");
              pty.emitData("first prompt> ");
              return { ...event, terminalId: opened.terminalId };
            }),
          ),
          Stream.take(2),
        ),
      );
      expect(messages[0]).toMatchObject({ type: "renderer-events-ready", channel: "terminals" });
      expect(messages[1]).toMatchObject({ type: "terminal-data", data: "first prompt> " });
    }).pipe(Effect.provide(layer())),
  );

  it.effect("rejects opens already resolving when another window closes the directory", () =>
    Effect.gen(function* () {
      const terminal = yield* Terminal;
      const resolving = yield* Deferred.make<void>();
      let finishRealpath: ((path: string) => void) | undefined;
      native.realpath.mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            finishRealpath = resolve;
            Deferred.doneUnsafe(resolving, Effect.void);
          }),
      );
      const opening = yield* terminal
        .open(2, { workingDirectory: "/canonical" }, 80, 24)
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(resolving);
      yield* terminal.closeWorkingDirectory("/canonical");
      if (!finishRealpath) throw new Error("Open did not reach realpath");
      finishRealpath("/canonical");
      const failure = yield* Fiber.join(opening);
      expect(failure.message).toContain("closed while opening");
      expect(native.spawn).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer())),
  );

  it.effect(
    "counts and closes the same collection across windows, isolating other directories",
    () =>
      Effect.gen(function* () {
        const terminal = yield* Terminal;
        yield* terminal.open(1, { workingDirectory: "/alias" }, 80, 24);
        yield* terminal.open(2, { workingDirectory: "/canonical" }, 80, 24);
        yield* terminal.open(2, { workingDirectory: "/other" }, 80, 24);
        const [first, second, other] = processes;
        if (!first || !second || !other) throw new Error("Expected three PTYs");
        first.process = "sleep";
        second.process = "node";
        other.process = "node";
        expect(yield* terminal.runningProgramCount("/alias")).toBe(2);
        yield* terminal.closeWorkingDirectory("/alias");
        expect(first.kill).toHaveBeenCalledOnce();
        expect(second.kill).toHaveBeenCalledOnce();
        expect(other.kill).not.toHaveBeenCalled();
        expect(yield* terminal.runningProgramCount("/alias")).toBe(0);
      }).pipe(Effect.provide(layer())),
  );

  it.effect("cleans up through the captured canonical identity after the checkout disappears", () =>
    Effect.gen(function* () {
      const terminal = yield* Terminal;
      yield* terminal.open(1, { workingDirectory: "/alias" }, 80, 24);
      const [pty] = processes;
      if (!pty) throw new Error("Expected a PTY");
      pty.process = "sleep";
      native.realpath.mockRejectedValue(
        Object.assign(new Error("Directory removed"), { code: "ENOENT" }),
      );
      expect(yield* terminal.runningProgramCount("/alias")).toBe(1);
      yield* terminal.closeWorkingDirectory("/alias");
      yield* terminal.closeWorkingDirectory("/alias");
      yield* terminal.closeWorkingDirectory("/missing-with-no-terminals");
      expect(native.realpath).toHaveBeenCalledTimes(1);
      expect(pty.kill).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer())),
  );

  it.effect("still enforces path access for inspection and cleanup", () =>
    Effect.gen(function* () {
      const terminal = yield* Terminal;
      const inspect = yield* terminal.runningProgramCount("/forbidden").pipe(Effect.flip);
      const close = yield* terminal.closeWorkingDirectory("/forbidden").pipe(Effect.flip);
      expect(inspect.message).toContain("not selected");
      expect(close.message).toContain("not selected");
    }).pipe(Effect.provide(layer())),
  );
});
