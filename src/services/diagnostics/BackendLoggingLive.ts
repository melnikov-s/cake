import { Cause, Effect, FileSystem, Logger, Path, Semaphore } from "effect";

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const BACKUPS = 3;
const sdkTimingWarnings = new Set<unknown>(["Slow Cake operation", "Slow Cake tool execution"]);

/** Host-owned operational logs, separate from Pi's transcript authority. */
export const makeBackendLoggingLive = (
  directory: string,
  host: "desktop" | "server",
  options?: {
    readonly console?: Pick<Console, "warn">;
    readonly maxFileBytes?: number;
  },
) => {
  const target = options?.console ?? console;
  const consoleLogger = Logger.withConsoleLog(Logger.formatLogFmt);
  const fileLogger = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fiber = yield* Effect.fiber;
    const file = path.join(directory, `${host}.log`);
    const maxBytes = options?.maxFileBytes ?? MAX_FILE_BYTES;
    const lock = yield* Semaphore.make(1);
    const warn = target.warn.bind(target);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    let bytes = (yield* fs.exists(file)) ? Number((yield* fs.stat(file)).size) : 0;

    const rotate = Effect.fn("BackendLogging.rotate")(function* () {
      for (let index = BACKUPS; index >= 1; index--) {
        const source = index === 1 ? file : `${file}.${index - 1}`;
        const destination = `${file}.${index}`;
        if (!(yield* fs.exists(source))) continue;
        if (yield* fs.exists(destination)) yield* fs.remove(destination);
        yield* fs.rename(source, destination);
      }
      bytes = 0;
    });
    const write = Effect.fn("BackendLogging.write")(
      function* (records: string[]) {
        for (const record of records) {
          let line = `${record}\n`;
          let size = Buffer.byteLength(line);
          if (size > Math.min(MAX_RECORD_BYTES, maxBytes)) {
            line = `${JSON.stringify({ timestamp: new Date().toISOString(), level: "Warn", message: "Diagnostic record omitted: size limit exceeded", byteLength: size })}\n`;
            size = Buffer.byteLength(line);
          }
          if (bytes + size > maxBytes) yield* rotate();
          yield* fs.writeFileString(file, line, { flag: "a", mode: 0o600 });
          bytes += size;
        }
      },
      lock.withPermit,
      Effect.uninterruptible,
      Effect.catch((error) => Effect.sync(() => warn("Cake diagnostic log write failed", error))),
    );
    // Disk I/O is asynchronous and batched, not part of the caller's hot path.
    // Logger.batched flushes pending records when its owning runtime closes.
    const batched = yield* Logger.batched(Logger.formatJson, {
      window: "250 millis",
      flush: write,
    });

    // These two SDK callback boundaries are not Effect fibers. Preserve their
    // existing console output and retain just the known metadata-only diagnostics;
    // do not indiscriminately capture console output from tools or extensions.
    const previousWarn = target.warn;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        target.warn = (...args: unknown[]) => {
          warn(...args);
          if (sdkTimingWarnings.has(args[0]))
            batched.log({
              message: args,
              logLevel: "Warn",
              cause: Cause.empty,
              fiber,
              date: new Date(),
            });
        };
      }),
      () =>
        Effect.sync(() => {
          target.warn = previousWarn;
        }),
    );
    return Logger.make((event) => {
      consoleLogger.log(event);
      batched.log(event);
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        target.warn("Cake file logging unavailable; continuing with console logging", error);
        return consoleLogger;
      }),
    ),
  );
  return Logger.layer([fileLogger]);
};
