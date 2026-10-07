import { beforeEach, vi } from "vitest";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Schema, Stream } from "effect";
import { DictationState } from "../../../src/domain/dictation/dictation-data";
import { Dictation } from "../../../src/services/dictation/Dictation";
import { makeDictationLive } from "../../../src/services/dictation/DictationLive";

const native = vi.hoisted(() => ({
  path: "/external/model" as string | undefined,
  available: true,
  ready: () => Promise.resolve(),
  transcribe: vi.fn(async () => "hello"),
  detectSpeech: vi.fn(async () => true),
  constructed: vi.fn(),
  close: vi.fn(),
  install: vi.fn<
    (root: string, signal: AbortSignal, progress: (value: unknown) => void) => Promise<void>
  >(async () => {}),
  remove: vi.fn(async () => {}),
}));
vi.mock("node:fs/promises", () => ({ rm: native.remove }));
vi.mock("../../../src/services/dictation/local-parakeet", () => ({
  helperAvailable: async () => native.available,
  loadModelPath: async () => native.path,
  saveModelPath: async (_root: string, path: string) => {
    native.path = path;
  },
  validateModel: async (path: string) => {
    if (path === "/invalid") throw new Error("Invalid model folder");
  },
  installParakeet: native.install,
  ParakeetWorker: class {
    ready: Promise<void>;
    constructor(executable: string, path: string) {
      native.constructed(executable, path);
      this.ready = native.ready();
    }
    transcribe = native.transcribe;
    detectSpeech = native.detectSpeech;
    close = native.close;
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  native.path = "/external/model";
  native.available = true;
  native.ready = () => Promise.resolve();
  native.install.mockImplementation(async () => {});
  native.remove.mockImplementation(async () => {
    native.path = undefined;
  });
});
const live = (supported = true) =>
  makeDictationLive("/fixture", supported, "/bundle/cake-dictation");
const state = (service: Dictation["Service"]) =>
  service.observeState().pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((values) => values[0]!),
  );

it.effect("projects RPC-encodable state with independently bundled engine availability", () =>
  Effect.gen(function* () {
    const service = yield* Dictation;
    const encoded = yield* Schema.encodeEffect(DictationState)(yield* state(service));
    expect(encoded).toMatchObject({
      status: "installed",
      modelPath: "/external/model",
      engineAvailable: true,
    });
    yield* service.remove();
    const removed = yield* state(service);
    yield* Schema.encodeEffect(DictationState)(removed);
    expect(removed).toMatchObject({
      status: "missing",
      modelPath: undefined,
      engineAvailable: true,
    });
  }).pipe(Effect.provide(live())),
);

it.effect("concurrent prepare calls acquire one bundled worker and wait for warmup", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<void>(),
      started = yield* Deferred.make<void>();
    native.ready = () => {
      Effect.runSync(Deferred.succeed(started, undefined));
      return Effect.runPromise(Deferred.await(ready));
    };
    const service = yield* Dictation;
    const first = yield* service.prepare().pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const second = yield* service.prepare().pipe(Effect.forkChild);
    expect((yield* state(service)).status).toBe("loading");
    yield* Deferred.succeed(ready, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(native.constructed).toHaveBeenCalledExactlyOnceWith(
      "/bundle/cake-dictation",
      "/external/model",
    );
    expect((yield* state(service)).status).toBe("ready");
    expect(yield* service.transcribe({ utteranceId: "focus-1", pcm: "", final: true })).toBe(
      "hello",
    );
    expect(yield* service.detectSpeech({ captureId: "capture-1", pcm: "AAAAAA==" })).toBe(true);
    yield* service.release();
    expect(native.close).toHaveBeenCalledTimes(1);
    expect((yield* state(service)).status).toBe("installed");
  }).pipe(Effect.provide(live())),
);

it.effect(
  "cancels model download at the boundary and permits retry without changing the active selection",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let cancelled = false;
      native.install.mockImplementation(
        (_root, signal) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
            Effect.runSync(Deferred.succeed(started, undefined));
          }),
      );
      const service = yield* Dictation;
      const installation = yield* service.install().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect((yield* state(service)).status).toBe("installing");
      yield* Fiber.interrupt(installation);
      expect(cancelled).toBe(true);
      expect(yield* state(service)).toMatchObject({
        status: "installed",
        modelPath: "/external/model",
      });
      native.install.mockImplementation(async () => {});
      yield* service.install();
      expect(yield* state(service)).toMatchObject({
        status: "installed",
        modelPath: "/fixture/model",
      });
    }).pipe(Effect.provide(live())),
);

it.effect(
  "selecting a local Core ML model needs no download and removal only touches Cake's model data",
  () =>
    Effect.gen(function* () {
      const service = yield* Dictation;
      yield* service.setModelPath("/external/another-model");
      yield* service.prepare();
      expect(native.install).not.toHaveBeenCalled();
      expect(native.constructed).toHaveBeenCalledWith(
        "/bundle/cake-dictation",
        "/external/another-model",
      );
      yield* service.remove();
      expect(native.remove).toHaveBeenCalledWith("/fixture", { recursive: true, force: true });
      expect(yield* state(service)).toMatchObject({ status: "missing", engineAvailable: true });
    }).pipe(Effect.provide(live())),
);

it.effect("invalid local folders leave the previous selection intact", () =>
  Effect.gen(function* () {
    const service = yield* Dictation;
    expect((yield* service.setModelPath("/invalid").pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* state(service)).message).toBe("Invalid model folder");
    expect(native.path).toBe("/external/model");
  }).pipe(Effect.provide(live())),
);

it.effect(
  "unsupported macOS or architecture explains the requirement without starting a download",
  () =>
    Effect.gen(function* () {
      const service = yield* Dictation;
      expect((yield* state(service)).supported).toBe(false);
      expect((yield* service.install().pipe(Effect.result))._tag).toBe("Failure");
      expect(native.install).not.toHaveBeenCalled();
      expect(native.constructed).not.toHaveBeenCalled();
      expect((yield* state(service)).message).toContain("macOS 14");
    }).pipe(Effect.provide(live(false))),
);

it.effect("a missing bundled helper is a repairable app error, not a runtime installation", () =>
  Effect.gen(function* () {
    native.available = false;
    const service = yield* Dictation;
    expect((yield* service.prepare().pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* state(service)).message).toContain("Reinstall or update Cake");
    expect(native.install).not.toHaveBeenCalled();
  }).pipe(Effect.provide(live())),
);

it.effect("speech detection and recognition share the serialized worker", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let detecting = false;
    native.detectSpeech.mockImplementationOnce(async () => {
      detecting = true;
      Effect.runSync(Deferred.succeed(started, undefined));
      await Effect.runPromise(Deferred.await(finish));
      detecting = false;
      return false;
    });
    native.transcribe.mockImplementationOnce(async () => {
      expect(detecting).toBe(false);
      return "Quiet speech";
    });
    const service = yield* Dictation;
    yield* service.prepare();
    const detection = yield* service
      .detectSpeech({ captureId: "capture-1", pcm: "AAAAAA==" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const transcription = yield* service
      .transcribe({ utteranceId: "field-1", pcm: "", final: true })
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finish, undefined);
    expect(yield* Fiber.join(detection)).toBe(false);
    expect(yield* Fiber.join(transcription)).toBe("Quiet speech");
    expect(native.constructed).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(live())),
);

it.effect("interrupted speech detection discards the worker and allows re-preparation", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    native.detectSpeech.mockImplementationOnce(() => {
      Effect.runSync(Deferred.succeed(started, undefined));
      return new Promise<boolean>(() => {});
    });
    const service = yield* Dictation;
    yield* service.prepare();
    const detection = yield* service
      .detectSpeech({ captureId: "abandoned", pcm: "AAAAAA==" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(detection);
    expect((yield* state(service)).status).toBe("installed");
    yield* service.prepare();
    expect(native.constructed).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(live())),
);

it.effect("interrupting inference discards the worker and permits a fresh warmup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    native.transcribe.mockImplementationOnce(() => {
      Effect.runSync(Deferred.succeed(started, undefined));
      return new Promise<string>(() => {});
    });
    const service = yield* Dictation;
    yield* service.prepare();
    const transcription = yield* service
      .transcribe({ utteranceId: "abandoned", pcm: "", final: false })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(transcription);
    expect((yield* state(service)).status).toBe("installed");
    yield* service.prepare();
    expect(native.constructed).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(live())),
);
