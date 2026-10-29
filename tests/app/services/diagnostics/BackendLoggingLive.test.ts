import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { makeBackendLoggingLive } from "../../../../src/services/diagnostics/BackendLoggingLive";

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const consoleFixture = () => {
  const warnings: unknown[][] = [];
  return {
    warnings,
    target: {
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
  };
};

it.effect("retains Effect logs and SDK timing warnings and flushes/restores on runtime close", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-backend-logs-" });
    const { target, warnings } = consoleFixture();
    const originalWarn = target.warn;
    const logging = makeBackendLoggingLive(directory, "desktop", { console: target });
    const result = yield* Effect.gen(function* () {
      yield* Effect.logInfo("Backend started");
      yield* Effect.logWarning("Slow workflow session list", { totalMs: 39_000 });
      target.warn("Slow Cake operation", { call: "hashed-call", phasesMs: { execute: 38_000 } });
      target.warn("Slow Cake tool execution", { call: "hashed-call", durationMs: 39_000 });
      target.warn("Unrelated extension console output", "PRIVATE_TOOL_OUTPUT");
      return 42;
    }).pipe(Effect.provide(logging));
    expect(result).toBe(42);
    expect(target.warn).toBe(originalWarn);
    expect(warnings).toHaveLength(3);
    const contents = yield* fs.readFileString(path.join(directory, "desktop.log"));
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toHaveLength(4);
    expect(contents).toContain("Backend started");
    expect(contents).toContain("Slow workflow session list");
    expect(contents).toContain('"totalMs":39000');
    expect(contents).toContain("Slow Cake operation");
    expect(contents).toContain("Slow Cake tool execution");
    expect(contents).toContain("hashed-call");
    expect(contents).not.toContain("PRIVATE_TOOL_OUTPUT");
  }).pipe(Effect.provide(platform)),
);

it.effect("flushes asynchronously while the backend is still running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-live-log-flush-" });
    const flushed = yield* Deferred.make<void>();
    const { target } = consoleFixture();
    yield* Effect.gen(function* () {
      yield* Effect.logWarning("Visible before shutdown");
      expect(yield* fs.exists(path.join(directory, "desktop.log"))).toBe(false);
      yield* TestClock.adjust("250 millis");
      yield* Deferred.await(flushed);
      expect(yield* fs.readFileString(path.join(directory, "desktop.log"))).toContain(
        "Visible before shutdown",
      );
    }).pipe(
      Effect.provide(makeBackendLoggingLive(directory, "desktop", { console: target })),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (file, content, options) =>
          fs
            .writeFileString(file, content, options)
            .pipe(Effect.tap(() => Deferred.succeed(flushed, undefined))),
      }),
    );
  }).pipe(Effect.provide(platform)),
);

it.effect("bounds disk retention by bytes, keeps recent logs, and appends across restarts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-log-rotation-" });
    const { target } = consoleFixture();
    const logging = () =>
      makeBackendLoggingLive(directory, "server", { console: target, maxFileBytes: 512 });
    yield* Effect.forEach(
      Array.from({ length: 20 }, (_, index) => index),
      (index) => Effect.logInfo(`marker-${String(index).padStart(2, "0")}-${"x".repeat(80)}`),
    ).pipe(Effect.provide(logging()));
    const files = yield* fs.readDirectory(directory);
    expect(files.sort()).toEqual(["server.log", "server.log.1", "server.log.2", "server.log.3"]);
    const contents = yield* Effect.forEach(files, (file) =>
      fs.readFileString(path.join(directory, file)),
    );
    for (const content of contents) {
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(512);
      for (const line of content.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(contents.join("\n")).toContain("marker-19");
    expect(contents.join("\n")).not.toContain("marker-00");
    yield* Effect.logWarning("after-restart").pipe(Effect.provide(logging()));
    const after = yield* Effect.forEach(files, (file) =>
      fs.readFileString(path.join(directory, file)),
    );
    expect(after.join("\n")).toContain("after-restart");
    expect(after.join("\n")).toContain("marker-19");
    for (const content of after) expect(Buffer.byteLength(content)).toBeLessThanOrEqual(512);
  }).pipe(Effect.provide(platform)),
);

it.effect("omits oversized records instead of exceeding the file limit", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-log-record-limit-" });
    const { target } = consoleFixture();
    yield* Effect.logWarning("PRIVATE_PAYLOAD_".repeat(10_000)).pipe(
      Effect.provide(makeBackendLoggingLive(directory, "desktop", { console: target })),
    );
    const contents = yield* fs.readFileString(path.join(directory, "desktop.log"));
    expect(Buffer.byteLength(contents)).toBeLessThan(1024);
    expect(JSON.parse(contents).message).toContain("size limit exceeded");
    expect(contents).not.toContain("PRIVATE_PAYLOAD");
  }).pipe(Effect.provide(platform)),
);

it.effect("unavailable log directories do not prevent the backend from running", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { target, warnings } = consoleFixture();
    const originalWarn = target.warn;
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "BackendLoggingTest",
      method: "makeDirectory",
    });
    const result = yield* Effect.succeed("backend still runs").pipe(
      Effect.provide(makeBackendLoggingLive("/unavailable/logs", "desktop", { console: target })),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        makeDirectory: () => Effect.fail(failure),
      }),
    );
    expect(result).toBe("backend still runs");
    expect(target.warn).toBe(originalWarn);
    expect(warnings[0]?.[0]).toBe("Cake file logging unavailable; continuing with console logging");
  }).pipe(Effect.provide(platform)),
);

it.effect("write failures warn on the console without failing backend work or recursing", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-log-write-failure-" });
    const { target, warnings } = consoleFixture();
    const failure = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "BackendLoggingTest",
      method: "writeFileString",
    });
    const result = yield* Effect.logInfo("Before failed write").pipe(
      Effect.as(42),
      Effect.provide(makeBackendLoggingLive(directory, "desktop", { console: target })),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: () => Effect.fail(failure),
      }),
    );
    expect(result).toBe(42);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.[0]).toBe("Cake diagnostic log write failed");
  }).pipe(Effect.provide(platform)),
);
