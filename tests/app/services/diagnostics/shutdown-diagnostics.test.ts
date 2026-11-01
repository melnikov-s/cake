import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { makeShutdownLogWriter } from "../../../../src/services/diagnostics/BackendLoggingLive";
import {
  ShutdownDiagnostics,
  shutdownDiagnostics,
  shutdownResource,
  type ShutdownRecord,
} from "../../../../src/services/diagnostics/shutdown-diagnostics";
import { Git } from "../../../../src/services/git/Git";
import { makeGitLive } from "../../../../src/services/git/GitLive";

const deferred = <A>() => Promise.withResolvers<A>();
const quietConsole = () => ({ info: vi.fn(), warn: vi.fn() });
const directories: string[] = [];
afterEach(() => {
  shutdownDiagnostics.finish("cancelled");
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("identifies concurrent outstanding waits, not the last phase, and leaves settlement unchanged", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "performance"] });
  const timer = vi.spyOn(globalThis, "setInterval");
  const diagnostics = new ShutdownDiagnostics();
  const records: ShutdownRecord[] = [];
  const first = deferred<number>();
  const second = deferred<number>();
  const resource = shutdownResource("private/session/path");
  const a = diagnostics.promise("pi.abort", resource, () => first.promise);
  const b = diagnostics.promise("pi.abort", resource, () => second.promise);
  expect(vi.getTimerCount()).toBe(0);
  diagnostics.start((record) => records.push(record));
  diagnostics.start(() => {
    throw new Error("must not replace sink on repeated quit");
  });
  expect(vi.getTimerCount()).toBe(1);
  expect(timer.mock.results[0]?.value.hasRef()).toBe(false);
  expect(records.at(-1)?.pending).toEqual([
    expect.objectContaining({ id: 1, operation: "pi.abort", resource }),
    expect.objectContaining({ id: 2, operation: "pi.abort", resource }),
  ]);
  first.resolve(7);
  expect(await a).toBe(7);
  const failure = new Error("SECRET tool payload");
  await expect(
    diagnostics.promise("mcp.close", resource, () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
  vi.advanceTimersByTime(10_000);
  expect(records.at(-1)).toMatchObject({
    event: "pending",
    pendingCount: 1,
    pending: [{ id: 2, elapsedMs: 10_000 }],
  });
  expect(records.some((record) => record.id === 1 && record.event === "completed")).toBe(true);
  expect(
    records.some((record) => record.operation === "mcp.close" && record.event === "failed"),
  ).toBe(true);
  expect(JSON.stringify(records)).not.toMatch(/SECRET|private\/session\/path/);
  second.resolve(9);
  expect(await b).toBe(9);
  diagnostics.finish("completed");
  expect(vi.getTimerCount()).toBe(0);
  expect(records.at(-1)).toMatchObject({
    event: "completed",
    operation: "shutdown",
    elapsedMs: 10_000,
  });
  timer.mockRestore();
});

it("bounds pending snapshots and clears the observer on cancelled quit/retry", () => {
  vi.useFakeTimers();
  const diagnostics = new ShutdownDiagnostics();
  const records: ShutdownRecord[] = [];
  const ends = Array.from({ length: 65 }, () => diagnostics.begin("cleanup"));
  diagnostics.start((record) => records.push(record));
  expect(records.at(-1)).toMatchObject({ pendingCount: 65, omitted: 15 });
  expect(records.at(-1)?.pending).toHaveLength(50);
  diagnostics.finish("cancelled");
  expect(vi.getTimerCount()).toBe(0);
  ends[0]?.("completed");
  diagnostics.start((record) => records.push(record));
  expect(records.at(-1)?.pendingCount).toBe(64);
  ends.slice(1).forEach((end) => end("completed"));
  diagnostics.finish("completed");
});

effectIt.effect(
  "preserves Effect success, typed failures and interruption while retiring pending entries",
  () =>
    Effect.gen(function* () {
      const diagnostics = new ShutdownDiagnostics();
      const records: ShutdownRecord[] = [];
      diagnostics.start((record) => records.push(record));
      try {
        expect(yield* diagnostics.effect("success", undefined, Effect.succeed(42))).toBe(42);
        const failure = yield* diagnostics
          .effect("failure", undefined, Effect.fail("private failure"))
          .pipe(Effect.flip);
        expect(failure).toBe("private failure");
        const entered = yield* Deferred.make<void>();
        const stalled = yield* diagnostics
          .effect(
            "stalled",
            "safe-id",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(stalled);
        expect(
          records
            .filter((record) => record.event !== "started" && record.event !== "pending")
            .map((record) => [record.operation, record.event]),
        ).toEqual([
          ["success", "completed"],
          ["failure", "failed"],
          ["stalled", "interrupted"],
        ]);
      } finally {
        diagnostics.finish("completed");
      }
    }),
);

it("writes pre-wait records synchronously and retains them when reopened without shutdown completion", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-shutdown-log-"));
  directories.push(directory);
  const target = quietConsole();
  const diagnostics = new ShutdownDiagnostics();
  diagnostics.start(makeShutdownLogWriter(directory, "desktop", { console: target }));
  const gate = deferred<void>();
  const file = join(directory, "desktop-shutdown.log");
  const cleanup = diagnostics.promise("pi.extensions.shutdown", shutdownResource("session"), () => {
    // Read inside the cleanup: no timer, runtime close or Promise turn has flushed this.
    expect(readFileSync(file, "utf8")).toContain('"operation":"pi.extensions.shutdown"');
    return gate.promise;
  });
  const before = readFileSync(file, "utf8");
  expect(before).not.toContain('"event":"completed"');
  const relaunched = new ShutdownDiagnostics();
  relaunched.start(makeShutdownLogWriter(directory, "desktop", { console: target }));
  expect(readFileSync(file, "utf8").startsWith(before)).toBe(true);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(target.info).toHaveBeenCalled();
  gate.resolve();
  await cleanup;
  diagnostics.finish("completed");
  relaunched.finish("completed");
});

it("rotates bounded logs and degrades to console on disk failure without failing cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cake-shutdown-rotation-"));
  directories.push(directory);
  const target = quietConsole();
  const write = makeShutdownLogWriter(directory, "desktop", { console: target, maxFileBytes: 512 });
  for (let i = 0; i < 30; i++)
    write({
      timestamp: new Date().toISOString(),
      run: "run",
      event: "started",
      operation: `cleanup-${i}`,
      elapsedMs: 0,
    });
  const files = readdirSync(directory);
  expect(files.sort()).toEqual([
    "desktop-shutdown.log",
    "desktop-shutdown.log.1",
    "desktop-shutdown.log.2",
    "desktop-shutdown.log.3",
  ]);
  for (const file of files) expect(statSync(join(directory, file)).size).toBeLessThanOrEqual(512);
  expect(readFileSync(join(directory, "desktop-shutdown.log"), "utf8")).toContain("cleanup-29");
  const blocked = join(directory, "not-a-directory");
  writeFileSync(blocked, "file");
  const diagnostics = new ShutdownDiagnostics();
  diagnostics.start(makeShutdownLogWriter(blocked, "desktop", { console: target }));
  expect(await diagnostics.promise("cleanup", undefined, () => 3)).toBe(3);
  diagnostics.finish("completed");
  expect(target.warn).toHaveBeenCalledTimes(1);
});

it("reports real Git service calls already outstanding at quit, with distinct safe IDs", async () => {
  const gates = [deferred<string>(), deferred<string>()] as const;
  const entered = deferred<void>();
  let calls = 0;
  const layer = makeGitLive(() => {
    const gate = gates[calls++];
    if (!gate) throw new Error("Unexpected Git call");
    if (calls === 2) entered.resolve();
    return gate.promise;
  });
  const records: ShutdownRecord[] = [];
  const run = (directory: string) =>
    Effect.runPromise(
      Effect.flatMap(Git, (git) => git.run(directory, ["status", "SECRET_ARG"])).pipe(
        Effect.provide(layer),
      ),
    );
  const a = run("/private/repo-a");
  const b = run("/private/repo-b");
  await entered.promise;
  shutdownDiagnostics.start((record) => records.push(record));
  const pending = records.at(-1)?.pending;
  expect(pending).toHaveLength(2);
  expect(pending?.map((entry) => entry.operation)).toEqual(["git.run", "git.run"]);
  expect(new Set(pending?.map((entry) => entry.id)).size).toBe(2);
  expect(pending?.map((entry) => entry.resource)).toEqual([
    shutdownResource("/private/repo-a"),
    shutdownResource("/private/repo-b"),
  ]);
  gates[0].resolve("first");
  gates[1].resolve("second");
  expect(await Promise.all([a, b])).toEqual(["first", "second"]);
  expect(records.filter((record) => record.event === "completed")).toHaveLength(2);
  expect(JSON.stringify(records)).not.toMatch(/SECRET_ARG|\/private/);
});
