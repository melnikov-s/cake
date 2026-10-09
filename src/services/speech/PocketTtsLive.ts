import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Queue, Schema, Semaphore, Stream, SubscriptionRef } from "effect";
import type { PocketTtsState } from "../../domain/speech/pocket-tts-data";
import {
  SpeechOutputError,
  SpeechOutputRequest,
  type SpeechOutputAudio,
} from "../../domain/speech/speech-output-data";
import { SpeechOutputSpeed } from "../../domain/speech/speech-output-speed";
import { PocketTts } from "./PocketTts";
import {
  installPocketTts,
  pocketTtsBytes,
  pocketTtsInstalled,
  removePocketTts,
  type PocketTtsInstallProgress,
} from "./pocket-tts-model";
import { PocketTtsWorker } from "./pocket-tts-worker";

// Selected-only persisted records predate provider-specific speed; they load at 1×.
const preferences = Schema.fromJsonString(
  Schema.Struct({
    selected: Schema.Boolean,
    speed: Schema.optionalKey(SpeechOutputSpeed),
  }),
);
const failure = (error: unknown) =>
  new SpeechOutputError({
    kind: "provider",
    message:
      error instanceof Error ? error.message : "Local speech failed. Re-enter voice mode to retry.",
  });

/** Acquisition only inspects local data. No subprocess or download until an explicit operation.
 * Main owns warm inference for its Scope; install/removal/selection/inference serialize.
 */
export const makePocketTtsLive = (root: string, supported: boolean, helperPath: string) =>
  Layer.effect(
    PocketTts,
    Effect.gen(function* () {
      const modelPath = join(root, "model");
      const state = yield* SubscriptionRef.make<PocketTtsState>({
        supported,
        engineAvailable: false,
        selected: false,
        speed: 1,
        installed: false,
        installing: false,
        downloadedBytes: 0,
        totalBytes: pocketTtsBytes,
      });
      const lock = yield* Semaphore.make(1);
      let worker: PocketTtsWorker | undefined;
      const stop = () => {
        worker?.close();
        worker = undefined;
      };
      yield* Effect.addFinalizer(() => Effect.sync(stop));
      const native = <A>(run: (signal: AbortSignal) => Promise<A>) =>
        Effect.tryPromise({ try: run, catch: failure });
      const patch = (value: Partial<PocketTtsState>) =>
        SubscriptionRef.update(state, (previous) => {
          const next = { ...previous, ...value };
          // optionalKey is omission, not a present undefined value, at the RPC boundary.
          if (next.message === undefined) delete next.message;
          return next;
        });
      const available = async () => {
        try {
          await access(helperPath, constants.X_OK);
          await access(join(dirname(helperPath), "pocket-tts-manifest.json"), constants.R_OK);
          return true;
        } catch (error) {
          if (
            error instanceof Error &&
            "code" in error &&
            (error.code === "ENOENT" || error.code === "EACCES")
          )
            return false;
          throw error;
        }
      };
      const refresh = Effect.fn("PocketTts.refresh")(function* () {
        const engineAvailable = supported && (yield* native(available));
        const installed = yield* native(() => pocketTtsInstalled(modelPath));
        yield* patch({ engineAvailable, installed, installing: false, message: undefined });
      });
      const loadPreferences = Effect.fn("PocketTts.loadPreferences")(function* () {
        const raw = yield* native(async () => {
          try {
            return await readFile(join(root, "settings.json"), "utf8");
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          }
        });
        if (raw !== undefined) {
          const saved = yield* Schema.decodeUnknownEffect(preferences)(raw).pipe(
            Effect.mapError(
              () =>
                new SpeechOutputError({
                  kind: "storage",
                  message: "Could not read local speech settings.",
                }),
            ),
          );
          yield* patch({ selected: saved.selected, speed: saved.speed ?? 1 });
        }
      });
      yield* refresh().pipe(Effect.catch((error) => patch({ message: error.message })));
      yield* loadPreferences().pipe(Effect.catch((error) => patch({ message: error.message })));
      const requireEngine = Effect.fn("PocketTts.requireEngine")(function* () {
        if (!supported)
          return yield* new SpeechOutputError({
            kind: "not-configured",
            message: "Local Pocket TTS requires Apple Silicon and macOS 14 or later.",
          });
        if (!(yield* native(available)))
          return yield* new SpeechOutputError({
            kind: "not-configured",
            message:
              "Cake's bundled local speech engine is missing. Rebuild, update or reinstall Cake.",
          });
      });
      const progress = yield* Queue.unbounded<PocketTtsInstallProgress>();
      yield* Stream.fromQueue(progress).pipe(
        Stream.runForEach((value) =>
          SubscriptionRef.update(state, (previous) =>
            previous.installing ? { ...previous, ...value } : previous,
          ),
        ),
        Effect.forkScoped,
      );
      const install = Effect.fn("PocketTts.install")(function* () {
        yield* requireEngine();
        stop();
        yield* patch({ installing: true, downloadedBytes: 0, message: undefined });
        // Wait for imperative download cleanup before releasing the installation lock.
        // Effect.tryPromise alone interrupts waiting, not the underlying filesystem work.
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const controller = new AbortController();
            return {
              controller,
              done: installPocketTts(root, controller.signal, (value) =>
                Queue.offerUnsafe(progress, value),
              ),
            };
          }),
          (download) => native(() => download.done),
          (download) =>
            Effect.promise(async () => {
              download.controller.abort();
              await download.done.catch(() => undefined);
            }),
        ).pipe(
          Effect.onInterrupt(() => refresh()),
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* refresh();
              yield* patch({ message: error.message });
              return yield* error;
            }),
          ),
        );
        yield* refresh();
        yield* patch({ downloadedBytes: pocketTtsBytes });
      }, lock.withPermit);
      const savePreferences = Effect.fn("PocketTts.savePreferences")(function* (next: {
        selected: boolean;
        speed: number;
      }) {
        yield* native(async () => {
          await mkdir(root, { recursive: true, mode: 0o700 });
          await writeFile(join(root, "settings.json.tmp"), JSON.stringify(next), {
            mode: 0o600,
          });
          await rename(join(root, "settings.json.tmp"), join(root, "settings.json"));
        }).pipe(Effect.andThen(patch(next)), Effect.uninterruptible);
      });
      const select = Effect.fn("PocketTts.select")(function* (selected: boolean) {
        if (selected) yield* requireEngine();
        const current = yield* SubscriptionRef.get(state);
        yield* savePreferences({ selected, speed: current.speed });
        if (!selected) stop();
      }, lock.withPermit);
      const setSpeed = Effect.fn("PocketTts.setSpeed")(function* (speed: number) {
        yield* Schema.decodeUnknownEffect(SpeechOutputSpeed)(speed).pipe(Effect.mapError(failure));
        const current = yield* SubscriptionRef.get(state);
        yield* savePreferences({ selected: current.selected, speed });
      }, lock.withPermit);
      const remove = Effect.fn("PocketTts.remove")(function* () {
        stop();
        yield* native(() => removePocketTts(root)).pipe(
          Effect.andThen(refresh()),
          Effect.uninterruptible,
        );
      }, lock.withPermit);
      const synthesize = (request: SpeechOutputRequest) =>
        Stream.callback<SpeechOutputAudio, SpeechOutputError>(
          Effect.fn("PocketTts.synthesize")(
            function* (queue) {
              yield* Effect.acquireRelease(lock.take(1), () => lock.release(1));
              yield* requireEngine();
              yield* Schema.decodeUnknownEffect(SpeechOutputRequest)(request).pipe(
                Effect.mapError(failure),
              );
              const current = yield* SubscriptionRef.get(state);
              if (!current.installed)
                return yield* new SpeechOutputError({
                  kind: "not-configured",
                  message: "Download Pocket TTS in Settings → Speech output first.",
                });
              if (!worker) {
                const next = new PocketTtsWorker(helperPath, modelPath);
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
              }
              const active = worker;
              yield* native((signal) =>
                active.synthesize(request.text, current.speed, signal, (audio) =>
                  Queue.offerUnsafe(queue, audio),
                ),
              );
              Queue.endUnsafe(queue);
            },
            (effect, queue) =>
              effect.pipe(
                Effect.onInterrupt(() => Effect.sync(stop)),
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    stop();
                    yield* Queue.fail(queue, error);
                  }),
                ),
              ),
          ),
        );
      return PocketTts.of({
        observeState: () => SubscriptionRef.changes(state),
        getState: () => SubscriptionRef.get(state),
        select,
        setSpeed,
        install,
        remove,
        synthesize,
      });
    }),
  );
