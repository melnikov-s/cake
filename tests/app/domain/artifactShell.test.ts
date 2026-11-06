import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, PlatformError, Sink, Stream } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import { ArtifactHostInvocation } from "../../../src/contracts/artifacts/artifact-commands";
import * as artifactCommands from "../../../src/domain/artifacts/artifactCommands";
import * as shell from "../../../src/domain/artifacts/artifactShell";
import { Schema } from "effect";

const input = { command: "fake-cli list | sort", cwd: "/work" };
const output = (value: string) => Stream.make(new TextEncoder().encode(value));
const handle = (
  options: {
    exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
    stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
    stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  } = {},
) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    exitCode: options.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: options.stdout ?? Stream.empty,
    stderr: options.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
const provideSpawner = (spawn: ChildProcessSpawner.ChildProcessSpawner["Service"]["spawn"]) =>
  Layer.merge(
    NodePath.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(spawn)),
  );

const realProcess = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);
const expectGone = (pid: number) => {
  expect(pid).toBeGreaterThan(0);
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
};

describe("artifact shell host", () => {
  it("discovers shell.run and its explicit host schema", () => {
    expect(artifactCommands.describe("shell.run")).toMatchObject({
      ok: true,
      commands: [
        {
          command: "shell.run",
          parameters: {
            required: ["command", "cwd"],
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
              env: { type: "object" },
              timeoutSeconds: { type: "number" },
            },
          },
        },
      ],
    });
    for (const arguments_ of [
      { command: "true" },
      { ...input, timeoutSeconds: 0 },
      { ...input, env: { KEY: 7 } },
    ])
      expect(
        Schema.decodeUnknownResult(ArtifactHostInvocation)({
          name: "shell.run",
          arguments: arguments_,
        })._tag,
      ).toBe("Failure");
    expect(
      Schema.decodeUnknownResult(ArtifactHostInvocation)({ name: "shell.run", arguments: input })
        ._tag,
    ).toBe("Success");
  });

  it.effect(
    "passes explicit cwd, shell syntax and env overlays to the process boundary and preserves nonzero status",
    () =>
      Effect.gen(function* () {
        const calls: ChildProcess.Command[] = [];
        const result = yield* shell
          .run({ ...input, env: { PATH: "/cli/bin", TOKEN: "value" } })
          .pipe(
            Effect.provide(
              provideSpawner((command) => {
                calls.push(command);
                return Effect.succeed(
                  handle({
                    stdout: output("out"),
                    stderr: output("err"),
                    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(17)),
                  }),
                );
              }),
            ),
          );
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          command: input.command,
          options: {
            shell: true,
            cwd: "/work",
            env: { PATH: "/cli/bin", TOKEN: "value" },
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: "5 seconds",
          },
        });
        expect(result).toEqual({
          stdout: "out",
          stderr: "err",
          exitCode: 17,
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
        });
      }),
  );

  it.effect(
    "rejects relative cwd before starting a process and exposes launch errors as typed failures",
    () =>
      Effect.gen(function* () {
        let starts = 0;
        const spawner = provideSpawner(() => {
          starts++;
          return Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.BadArgument({
                module: "ChildProcessSpawner",
                method: "spawn",
                description: "cannot launch",
              }),
            ),
          );
        });
        const relative = yield* shell
          .run({ ...input, cwd: "relative" })
          .pipe(Effect.provide(spawner), Effect.result);
        expect(relative).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ArtifactCommandError",
            command: "shell.run",
            message: expect.stringContaining("absolute"),
          },
        });
        expect(starts).toBe(0);
        const launch = yield* shell.run(input).pipe(Effect.provide(spawner), Effect.result);
        expect(launch).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ArtifactCommandError",
            message: expect.stringContaining("cannot launch"),
          },
        });
        expect(starts).toBe(1);
      }),
  );

  it.effect("bounds each output prefix while continuing to drain both streams", () =>
    Effect.gen(function* () {
      let drained = 0;
      const verbose = Stream.concat(output("a".repeat(60 * 1024)), output("tail")).pipe(
        Stream.tap(() =>
          Effect.sync(() => {
            drained++;
          }),
        ),
      );
      const result = yield* shell
        .run(input)
        .pipe(
          Effect.provide(
            provideSpawner(() => Effect.succeed(handle({ stdout: verbose, stderr: verbose }))),
          ),
        );
      expect(result.stdout).toBe("a".repeat(50 * 1024));
      expect(result.stderr).toBe(result.stdout);
      expect(result).toMatchObject({ stdoutTruncated: true, stderrTruncated: true, exitCode: 0 });
      expect(drained).toBe(4);
    }),
  );

  it.effect(
    "timeout settles only after scoped process cleanup and retains partial output without inventing an exit code",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let cleaned = false;
        const fiber = yield* shell.run({ ...input, timeoutSeconds: 2 }).pipe(
          Effect.provide(
            provideSpawner(() =>
              Effect.acquireRelease(
                Effect.succeed(
                  handle({
                    exitCode: Effect.never,
                    stdout: Stream.concat(
                      output("partial"),
                      Stream.fromEffect(Deferred.succeed(ready, undefined)).pipe(
                        Stream.drain,
                        Stream.concat(Stream.never),
                      ),
                    ),
                  }),
                ),
                () =>
                  Effect.sync(() => {
                    cleaned = true;
                  }),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust("2 seconds");
        expect(yield* Fiber.join(fiber)).toMatchObject({
          stdout: "partial",
          exitCode: null,
          timedOut: true,
        });
        expect(cleaned).toBe(true);
      }),
  );

  it.effect("cancellation preserves interruption and joins process cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let cleaned = false;
      const fiber = yield* shell.run(input).pipe(
        Effect.provide(
          provideSpawner(() =>
            Effect.acquireRelease(
              Deferred.succeed(started, undefined).pipe(
                Effect.as(handle({ exitCode: Effect.never })),
              ),
              () =>
                Effect.sync(() => {
                  cleaned = true;
                }),
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      expect(cleaned).toBe(true);
    }),
  );

  it.live(
    "runs a fake local CLI with shell quoting/pipes, required cwd and inherited environment plus PATH overlay",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-artifact-shell-")));
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => rm(root, { recursive: true, force: true })),
        );
        yield* Effect.promise(() =>
          writeFile(
            join(root, "fake-cli"),
            '#!/bin/sh\nprintf "%s\\n" "$PWD" "$CAKE_CLI_VALUE" "$HOME"\n',
            { mode: 0o755 },
          ),
        );
        const result = yield* shell.run({
          cwd: root,
          command: `fake-cli | cat; printf '%s' 'quoted | literal'; printf 'problem' >&2`,
          env: {
            PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
            CAKE_CLI_VALUE: "overlay value",
          },
        });
        const actualRoot = yield* Effect.promise(() => realpath(root));
        expect(result).toMatchObject({
          stdout: `${actualRoot}\noverlay value\n${process.env.HOME}\nquoted | literal`,
          stderr: "problem",
          exitCode: 0,
          timedOut: false,
        });
      }).pipe(Effect.provide(realProcess)),
  );

  it.live("timeout stops the real subprocess before returning", () =>
    Effect.gen(function* () {
      const result = yield* shell.run({
        command: "printf '%s\\n' \"$$\"; exec sleep 60",
        cwd: tmpdir(),
        timeoutSeconds: 0.5,
      });
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expectGone(Number(result.stdout.trim()));
    }).pipe(Effect.provide(realProcess)),
  );

  it.live("timeout cleans a background child even when its shell already exited successfully", () =>
    Effect.gen(function* () {
      const result = yield* shell.run({
        command: "sleep 60 & printf '%s\\n' \"$!\"; exit 0",
        cwd: tmpdir(),
        timeoutSeconds: 0.5,
      });
      const pid = Number(result.stdout.trim());
      expect(pid).toBeGreaterThan(0);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            if (pid > 0) process.kill(pid, "SIGKILL");
          } catch {
            /* Already cleaned by the runner. */
          }
        }),
      );
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      // An orphan can briefly remain a zombie awaiting the OS reaper, but must not be alive.
      const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
      expect(status.error).toBeUndefined();
      expect([0, 1]).toContain(status.status);
      expect(status.stdout.trim()).toMatch(/^(?:Z.*)?$/);
    }).pipe(Effect.provide(realProcess)),
  );

  it.live("cancellation stops the real subprocess after its readiness output", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const ready = yield* Deferred.make<number>();
      const observing = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.map((child) => ({
            ...child,
            stdout: child.stdout.pipe(Stream.tap(() => Deferred.succeed(ready, Number(child.pid)))),
          })),
        ),
      );
      const fiber = yield* shell
        .run({ command: "printf ready; exec sleep 60", cwd: tmpdir() })
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observing),
          Effect.forkChild,
        );
      const pid = yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expectGone(pid);
    }).pipe(Effect.provide(realProcess)),
  );
});
