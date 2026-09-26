import { join } from "node:path";
import { rm } from "node:fs/promises";
import { Effect, Layer, Queue, Semaphore, Stream, SubscriptionRef } from "effect";
import {
  DictationError,
  type DictationAudio,
  type DictationState,
} from "../../domain/dictation/dictation-data";
import { Dictation } from "./Dictation";
import {
  helperAvailable,
  installParakeet,
  loadModelPath,
  ParakeetWorker,
  saveModelPath,
  validateModel,
  type InstallProgress,
} from "./local-parakeet";

const failure = (error: unknown) =>
  new DictationError({ message: error instanceof Error ? error.message : String(error) });

/** Installation, model changes and inference serialize; a warm process lives until disabled or main exits. */
export const makeDictationLive = (root: string, supported: boolean, helperPath: string) =>
  Layer.effect(
    Dictation,
    Effect.gen(function* () {
      const managedModelPath = join(root, "model");
      const state = yield* SubscriptionRef.make<DictationState>({
        supported,
        status: "missing",
        managedModelPath,
        engineAvailable: false,
        downloadedBytes: 0,
        totalBytes: 0,
      });
      const lock = yield* Semaphore.make(1);
      let worker: ParakeetWorker | undefined;
      const stop = () => {
        worker?.close();
        worker = undefined;
      };
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      const patch = (value: Partial<DictationState>) =>
        SubscriptionRef.update(state, (previous) => ({ ...previous, ...value }));
      const native = <A>(run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: failure });
      const refresh = Effect.fn("Dictation.refresh")(function* () {
        const modelPath = yield* native(() => loadModelPath(root));
        const engineAvailable = yield* native(() => helperAvailable(helperPath));
        yield* patch({
          modelPath,
          engineAvailable,
          status: modelPath && engineAvailable ? "installed" : "missing",
          message: undefined,
          downloadedBytes: 0,
          totalBytes: 0,
        });
      });
      yield* refresh().pipe(
        Effect.catch((error) => patch({ status: "error", message: error.message })),
      );
      const requireSupported = Effect.fn("Dictation.requireSupported")(function* () {
        if (!supported)
          return yield* new DictationError({
            message: "Local Parakeet dictation requires Apple Silicon and macOS 14 or later.",
          });
        if (!(yield* native(() => helperAvailable(helperPath))))
          return yield* new DictationError({
            message: "Cake's bundled speech engine is missing. Reinstall or update Cake.",
          });
      });
      const resetAfterInterruption = Effect.fn("Dictation.resetAfterInterruption")(function* () {
        stop();
        yield* refresh().pipe(
          Effect.catch((error) => patch({ status: "error", message: error.message })),
        );
      });
      const guarded = <A>(operation: Effect.Effect<A, DictationError>) =>
        operation.pipe(
          Effect.onInterrupt(resetAfterInterruption),
          Effect.catch((error) =>
            Effect.gen(function* () {
              stop();
              yield* patch({ status: "error", message: error.message });
              return yield* error;
            }),
          ),
          lock.withPermits(1),
        );
      const progress = yield* Queue.unbounded<InstallProgress>();
      yield* Stream.fromQueue(progress).pipe(
        Stream.runForEach((value) =>
          SubscriptionRef.update(state, (previous) =>
            previous.status === "installing" ? { ...previous, ...value } : previous,
          ),
        ),
        Effect.forkScoped,
      );

      return Dictation.of({
        observeState: () => SubscriptionRef.changes(state),
        install: Effect.fn("Dictation.install")(function* () {
          yield* guarded(
            Effect.gen(function* () {
              yield* requireSupported();
              stop();
              yield* patch({
                status: "installing",
                message: "Preparing installation…",
                downloadedBytes: 0,
                totalBytes: 0,
              });
              yield* native((signal) =>
                installParakeet(root, signal, (value) => Queue.offerUnsafe(progress, value)),
              );
              yield* native(() => saveModelPath(root, managedModelPath));
              yield* refresh();
            }),
          );
        }),
        setModelPath: Effect.fn("Dictation.setModelPath")(function* (path: string) {
          yield* guarded(
            Effect.gen(function* () {
              yield* requireSupported();
              yield* native(() => validateModel(path));
              stop();
              yield* native(() => saveModelPath(root, path));
              yield* refresh();
            }),
          );
        }),
        remove: Effect.fn("Dictation.remove")(function* () {
          yield* guarded(
            Effect.gen(function* () {
              stop();
              // Never delete a user-selected model folder, only Cake's private installation.
              yield* native(() => rm(root, { recursive: true, force: true }));
              yield* refresh();
            }),
          );
        }),
        prepare: Effect.fn("Dictation.prepare")(function* () {
          yield* guarded(
            Effect.gen(function* () {
              yield* requireSupported();
              if (worker) return;
              const current = yield* SubscriptionRef.get(state);
              if (!current.modelPath || !current.engineAvailable)
                return yield* new DictationError({
                  message: "Install Parakeet in Settings → Dictation first.",
                });
              yield* patch({ status: "loading", message: "Preparing dictation…" });
              const next = new ParakeetWorker(helperPath, current.modelPath);
              worker = next;
              yield* native(async (signal) => {
                const cancel = () => next.close();
                signal.addEventListener("abort", cancel, { once: true });
                try {
                  await next.ready;
                } finally {
                  signal.removeEventListener("abort", cancel);
                }
              });
              yield* patch({ status: "ready", message: undefined });
            }),
          );
        }),
        release: Effect.fn("Dictation.release")(function* () {
          // Kill immediately, including a loading/in-flight worker; do not wait behind inference.
          stop();
          yield* lock.withPermits(1)(refresh());
        }),
        transcribe: Effect.fn("Dictation.transcribe")(function* (audio: DictationAudio) {
          return yield* guarded(
            Effect.gen(function* () {
              const active = worker;
              if (!active)
                return yield* new DictationError({
                  message: "The speech model is not ready. Enable dictation again to retry.",
                });
              return yield* native((signal) => {
                const cancel = () => active.close();
                signal.addEventListener("abort", cancel, { once: true });
                return active
                  .transcribe(audio)
                  .finally(() => signal.removeEventListener("abort", cancel));
              });
            }),
          );
        }),
      });
    }),
  );
