import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  PlatformError,
  Queue,
  Ref,
  Result,
  Stream,
} from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import type {
  SpeechOutputError,
  SpeechOutputAudio,
} from "../../../src/domain/speech/speech-output-data";
import { ElevenLabsSpeech } from "../../../src/services/speech/ElevenLabsSpeech";
import { ElevenLabsSpeechLive } from "../../../src/services/speech/ElevenLabsSpeechLive";
import {
  type SpeechOutputDiagnostic,
  SpeechOutputDiagnostics,
} from "../../../src/services/speech/SpeechOutputDiagnostics";
import { makeSpeechOutputDiagnosticsLive } from "../../../src/services/speech/SpeechOutputDiagnosticsLive";
import {
  SpeechOutputStorage,
  type StoredSpeechOutputSettings,
} from "../../../src/services/speech/SpeechOutputStorage";
import {
  makeSpeechOutputStorageLive,
  type SpeechKeyEncryption,
} from "../../../src/services/speech/SpeechOutputStorageLive";

const secret = "private-elevenlabs-test-key";
const configured = { apiKey: secret, voiceId: "explicit-voice" };
const target = "private/speech/settings.json";
const fsError = (method: string, notFound = false) =>
  PlatformError.systemError({
    _tag: notFound ? "NotFound" : "PermissionDenied",
    module: "SpeechTestFileSystem",
    method,
  });

const makeFileSystem = Effect.fn("SpeechTest.makeFileSystem")(() =>
  Effect.sync(() => {
    const files = new Map<string, string>();
    const permissions = new Map<string, number>();
    const operations: string[] = [];
    let nextFile = 0;
    const controls = { failRead: false, failRename: false };
    const fs = FileSystem.makeNoop({
      readFileString: (path) => {
        operations.push("read");
        const raw = files.get(path);
        return controls.failRead
          ? Effect.fail(fsError("read"))
          : raw === undefined
            ? Effect.fail(fsError("read", true))
            : Effect.succeed(raw);
      },
      makeDirectory: (path, options) =>
        Effect.sync(() => {
          operations.push("mkdir");
          permissions.set(path, options?.mode ?? 0);
        }),
      chmod: (path, mode) =>
        Effect.sync(() => {
          permissions.set(path, mode);
        }),
      makeTempFile: (options) =>
        Effect.sync(() => {
          const path = `${options?.directory}/temporary-${nextFile++}.tmp`;
          files.set(path, "");
          return path;
        }),
      writeFileString: (path, content) =>
        Effect.sync(() => {
          expect(permissions.get(path)).toBe(0o600);
          operations.push("write");
          files.set(path, content);
        }),
      rename: (from, to) =>
        Effect.suspend(() => {
          if (controls.failRename) return Effect.fail(fsError("rename"));
          const content = files.get(from);
          if (content === undefined) return Effect.fail(fsError("rename", true));
          operations.push("rename");
          files.set(to, content);
          files.delete(from);
          permissions.set(to, permissions.get(from) ?? 0);
          permissions.delete(from);
          return Effect.void;
        }),
      remove: (path) =>
        Effect.sync(() => {
          files.delete(path);
          permissions.delete(path);
        }),
    });
    return { fs, files, permissions, operations, controls };
  }),
);

const makeEncryption = () => {
  const controls = {
    available: true,
    failEncrypt: false,
    failDecrypt: false,
    encrypted: [] as string[],
    decrypted: 0,
  };
  const encryption: SpeechKeyEncryption = {
    available: () => controls.available,
    encrypt: (plaintext) => {
      if (controls.failEncrypt) throw new Error(`unsafe encryption failure ${secret}`);
      controls.encrypted.push(plaintext);
      return Uint8Array.from(Buffer.from(`encrypted:${plaintext}`), (byte) => byte ^ 0x5a);
    },
    decrypt: (bytes) => {
      if (controls.failDecrypt) throw new Error(`unsafe decryption failure ${secret}`);
      controls.decrypted++;
      return Buffer.from(Uint8Array.from(bytes, (byte) => byte ^ 0x5a))
        .toString()
        .slice("encrypted:".length);
    },
  };
  return { encryption, controls };
};

const memoryStorage = Effect.fn("SpeechTest.memoryStorage")(function* (
  initial: StoredSpeechOutputSettings = {},
) {
  const saved = yield* Ref.make(initial);
  return SpeechOutputStorage.of({
    load: () => Ref.get(saved),
    save: (settings) => Ref.set(saved, settings),
  });
});

const makeHttp = (
  respond: (
    request: HttpClientRequest.HttpClientRequest,
    signal: AbortSignal,
  ) => Effect.Effect<Response, HttpClientError.HttpClientError>,
) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const signals: AbortSignal[] = [];
  const client = HttpClient.make((request, _url, signal) => {
    requests.push(request);
    signals.push(signal);
    return respond(request, signal).pipe(
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    );
  });
  return { client, requests, signals };
};
const noRequests = () => makeHttp(() => Effect.die("Unexpected provider request"));
const audioResponse = (chunks: ReadonlyArray<Uint8Array>, type = "audio/pcm") =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": type } },
  );
const controlledAudio = () => {
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        output = controller;
      },
      cancel() {
        closed = true;
      },
    }),
    { headers: { "content-type": "audio/pcm" } },
  );
  return {
    response,
    abort: () => {
      if (!closed) {
        closed = true;
        output?.close();
      }
    },
    push: (bytes: Uint8Array) => {
      if (!closed) output?.enqueue(bytes);
    },
    close: () => {
      if (!closed) {
        closed = true;
        output?.close();
      }
    },
  };
};

const withSpeech = <A, E, R>(
  storage: SpeechOutputStorage["Service"],
  http: HttpClient.HttpClient,
  use: (speech: ElevenLabsSpeech["Service"]) => Effect.Effect<A, E, R>,
  diagnostics: SpeechOutputDiagnostics["Service"] = SpeechOutputDiagnostics.of({
    record: () => Effect.void,
  }),
) =>
  Effect.gen(function* () {
    return yield* use(yield* ElevenLabsSpeech);
  }).pipe(
    Effect.provide(
      ElevenLabsSpeechLive.pipe(
        Layer.provide([
          Layer.succeed(SpeechOutputStorage, storage),
          Layer.succeed(SpeechOutputDiagnostics, diagnostics),
          Layer.succeed(HttpClient.HttpClient, http),
        ]),
      ),
    ),
    Effect.scoped,
  );
const storageLayer = (
  fake: Effect.Success<ReturnType<typeof makeFileSystem>>,
  encryption: SpeechKeyEncryption,
) =>
  makeSpeechOutputStorageLive("private/speech", encryption).pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fake.fs)),
  );
const expectError = <A>(
  result: Result.Result<A, SpeechOutputError>,
  kind: SpeechOutputError["kind"],
) => {
  expect(Result.isFailure(result)).toBe(true);
  if (Result.isFailure(result)) {
    expect(result.failure._tag).toBe("SpeechOutputError");
    expect(result.failure.kind).toBe(kind);
    expect(JSON.stringify(result.failure)).not.toContain(secret);
  }
};

// Exercise real policy and deterministic concrete HTTP/filesystem/encryption boundaries only.
describe("ElevenLabs speech output contract", () => {
  it.effect(
    "settings observation starts with a coherent secret-free snapshot and publishes ordered saves",
    () =>
      Effect.gen(function* () {
        const updates = yield* Queue.unbounded<unknown>();
        const saveStarted = yield* Deferred.make<void>();
        const allowSave = yield* Deferred.make<void>();
        const saved = yield* Ref.make<StoredSpeechOutputSettings>(configured);
        const saves: StoredSpeechOutputSettings[] = [];
        let active = 0;
        let maximum = 0;
        const storage = SpeechOutputStorage.of({
          load: () => Ref.get(saved),
          save: (next) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active++;
                maximum = Math.max(maximum, active);
              }),
              () =>
                Effect.gen(function* () {
                  if (saves.length === 0) {
                    yield* Deferred.succeed(saveStarted, undefined);
                    yield* Deferred.await(allowSave);
                  }
                  saves.push(next);
                  yield* Ref.set(saved, next);
                }),
              () =>
                Effect.sync(() => {
                  active--;
                }),
            ),
        });
        const http = noRequests();
        yield* withSpeech(storage, http.client, (speech) =>
          Effect.gen(function* () {
            const observing = yield* speech.observeSettings().pipe(
              Stream.take(3),
              Stream.runForEach((value) => Queue.offer(updates, value)),
              Effect.forkChild,
            );
            expect(yield* Queue.take(updates)).toEqual({
              keyConfigured: true,
              voiceId: "explicit-voice",
              modelId: "eleven_flash_v2_5",
            });
            const first = yield* speech.setVoice("new-voice").pipe(Effect.forkChild);
            yield* Deferred.await(saveStarted);
            const second = yield* speech.setApiKey(null).pipe(Effect.forkChild);
            expect(saves).toHaveLength(0);
            yield* Deferred.succeed(allowSave, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            yield* Fiber.join(observing);
            expect(yield* Queue.take(updates)).toEqual({
              keyConfigured: true,
              voiceId: "new-voice",
              modelId: "eleven_flash_v2_5",
            });
            expect(yield* Queue.take(updates)).toEqual({
              keyConfigured: false,
              voiceId: "new-voice",
              modelId: "eleven_flash_v2_5",
            });
            expect(maximum).toBe(1);
            expect(saves).toEqual([
              { apiKey: secret, voiceId: "new-voice" },
              { voiceId: "new-voice" },
            ]);
            expect(yield* speech.observeSettings().pipe(Stream.take(1), Stream.runCollect)).toEqual(
              [{ keyConfigured: false, voiceId: "new-voice", modelId: "eleven_flash_v2_5" }],
            );
          }),
        );
        expect(http.requests).toHaveLength(0);
      }),
  );

  it.effect(
    "saving and removing a key use encrypted storage and never return or log the secret",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFileSystem();
        const crypto = makeEncryption();
        const http = noRequests();
        const logs: unknown[] = [];
        yield* Effect.gen(function* () {
          const storage = yield* SpeechOutputStorage;
          yield* withSpeech(storage, http.client, (speech) =>
            Effect.gen(function* () {
              expect(yield* speech.setApiKey(secret)).toBeUndefined();
              const raw = fake.files.get(target);
              expect(raw).toBeDefined();
              expect(raw).not.toContain(secret);
              expect(raw).not.toContain('apiKey"');
              expect(fake.permissions.get(target)).toBe(0o600);
              expect(fake.permissions.get("private/speech")).toBe(0o700);
              expect(yield* storage.load()).toEqual({ apiKey: secret });
              expect(crypto.controls.encrypted).toEqual([secret]);
              expect(crypto.controls.decrypted).toBe(1);
              expect(
                yield* speech.observeSettings().pipe(Stream.take(1), Stream.runCollect),
              ).toEqual([{ keyConfigured: true, modelId: "eleven_flash_v2_5" }]);
              expect(yield* speech.setApiKey(null)).toBeUndefined();
              expect(yield* storage.load()).toEqual({});
              expect(fake.files.get(target)).not.toContain("encryptedApiKey");
              expect([...fake.files.keys()]).toEqual([target]);
              expect(
                yield* speech.observeSettings().pipe(Stream.take(1), Stream.runCollect),
              ).toEqual([{ keyConfigured: false, modelId: "eleven_flash_v2_5" }]);
            }),
          );
        }).pipe(
          Effect.provide(storageLayer(fake, crypto.encryption)),
          Effect.provide(
            Logger.layer([
              Logger.map(Logger.formatStructured, (entry) => {
                logs.push(entry);
              }),
            ]),
          ),
        );
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(http.requests).toHaveLength(0);
      }),
  );

  it.effect(
    "unavailable secure storage rejects a save without a plaintext fallback or breaking app startup",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFileSystem();
        const crypto = makeEncryption();
        const http = noRequests();
        crypto.controls.available = false;
        fake.controls.failRead = true;
        yield* Effect.gen(function* () {
          const storage = yield* SpeechOutputStorage;
          // Both layers acquire successfully without touching storage, encryption or network.
          yield* withSpeech(storage, http.client, (speech) =>
            Effect.gen(function* () {
              expect(fake.operations).toEqual([]);
              expectError(
                yield* speech
                  .observeSettings()
                  .pipe(Stream.take(1), Stream.runCollect, Effect.result),
                "storage",
              );
              fake.controls.failRead = false;
              expectError(yield* speech.setApiKey(secret).pipe(Effect.result), "storage");
              expect(fake.files.size).toBe(0);
              expect(crypto.controls.encrypted).toEqual([]);
              crypto.controls.available = true;
              crypto.controls.failEncrypt = true;
              expectError(yield* speech.setApiKey(secret).pipe(Effect.result), "storage");
              expect(fake.files.size).toBe(0);
              crypto.controls.failEncrypt = false;
              yield* speech.setApiKey(secret);
              const original = fake.files.get(target);
              fake.controls.failRename = true;
              expectError(yield* speech.setVoice("failed-voice").pipe(Effect.result), "storage");
              expect(fake.files.get(target)).toBe(original);
              expect([...fake.files.keys()]).toEqual([target]);
              expect(
                yield* speech.observeSettings().pipe(Stream.take(1), Stream.runCollect),
              ).toEqual([{ keyConfigured: true, modelId: "eleven_flash_v2_5" }]);
              crypto.controls.available = false;
              expectError(yield* storage.load().pipe(Effect.result), "storage");
            }),
          );
        }).pipe(Effect.provide(storageLayer(fake, crypto.encryption)));
        expect(http.requests).toHaveLength(0);
      }),
  );

  it.effect(
    "lists available voices and persists the explicitly selected voice without generating preview audio",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFileSystem();
        const crypto = makeEncryption();
        const http = makeHttp(() =>
          Effect.succeed(
            Response.json({
              voices: [
                {
                  voice_id: "voice-a",
                  name: "First",
                  preview_url: "https://never-fetch.test/audio",
                },
                { voice_id: "voice-b", name: "Second" },
              ],
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const storage = yield* SpeechOutputStorage;
          yield* withSpeech(storage, http.client, (speech) =>
            Effect.gen(function* () {
              yield* speech.setApiKey(secret);
              expect(yield* speech.listVoices()).toEqual([
                { id: "voice-a", name: "First" },
                { id: "voice-b", name: "Second" },
              ]);
              expect(yield* storage.load()).toEqual({ apiKey: secret });
              yield* speech.setVoice("voice-b");
              expect(yield* storage.load()).toEqual({ apiKey: secret, voiceId: "voice-b" });
              expect(
                yield* speech.observeSettings().pipe(Stream.take(1), Stream.runCollect),
              ).toEqual([
                { keyConfigured: true, voiceId: "voice-b", modelId: "eleven_flash_v2_5" },
              ]);
            }),
          );
        }).pipe(Effect.provide(storageLayer(fake, crypto.encryption)));
        expect(http.requests).toHaveLength(1);
        expect(http.requests[0]?.method).toBe("GET");
        expect(http.requests[0]?.url).toBe("https://api.elevenlabs.io/v1/voices");
        expect(http.requests[0]?.headers["xi-api-key"]).toBe(secret);
        expect(http.signals[0]?.aborted).toBe(true);
      }),
  );

  it.effect(
    "streams bounded sample-aligned 24 kHz PCM before synthesis completes using the configured Flash voice",
    () =>
      Effect.gen(function* () {
        const storage = yield* memoryStorage(configured);
        const audio = controlledAudio();
        const started = yield* Deferred.make<void>();
        const chunks = yield* Queue.unbounded<SpeechOutputAudio>();
        const http = makeHttp(() =>
          Deferred.succeed(started, undefined).pipe(Effect.as(audio.response)),
        );
        yield* withSpeech(storage, http.client, (speech) =>
          Effect.gen(function* () {
            const synthesizing = yield* speech.synthesize({ text: "A short phrase." }).pipe(
              Stream.runForEach((chunk) => Queue.offer(chunks, chunk)),
              Effect.forkChild,
            );
            yield* Deferred.await(started);
            audio.push(new Uint8Array([1, 2, 3]));
            const first = yield* Queue.take(chunks);
            expect(first.encoding).toBe("pcm_s16le");
            expect(first.sampleRate).toBe(24_000);
            expect([...Buffer.from(first.pcm, "base64")]).toEqual([1, 2]);
            expect(http.signals[0]?.aborted).toBe(false);
            audio.push(new Uint8Array([4, 5, 6]));
            expect([...Buffer.from((yield* Queue.take(chunks)).pcm, "base64")]).toEqual([
              3, 4, 5, 6,
            ]);
            audio.push(new Uint8Array(65_536));
            const bounded = yield* Queue.take(chunks);
            expect(Buffer.from(bounded.pcm, "base64").byteLength).toBe(65_536);
            expect(bounded.pcm.length).toBeLessThanOrEqual(87_384);
            audio.close();
            yield* Fiber.join(synthesizing);
          }),
        );
        const request = http.requests[0];
        expect(http.requests).toHaveLength(1);
        expect(request?.url).toBe(
          "https://api.elevenlabs.io/v1/text-to-speech/explicit-voice/stream",
        );
        expect(request?.urlParams.params).toEqual([["output_format", "pcm_24000"]]);
        expect(request?.method).toBe("POST");
        expect(request?.headers["xi-api-key"]).toBe(secret);
        expect(request?.body._tag).toBe("Uint8Array");
        if (request?.body._tag === "Uint8Array")
          expect(JSON.parse(Buffer.from(request.body.body).toString())).toEqual({
            text: "A short phrase.",
            model_id: "eleven_flash_v2_5",
          });
        expect(http.signals[0]?.aborted).toBe(true);
      }),
  );

  it.effect(
    "cancelling synthesis closes its HTTP request and stops subsequent audio without retrying or rebilling",
    () =>
      Effect.gen(function* () {
        const storage = yield* memoryStorage(configured);
        const audio = controlledAudio();
        const received = yield* Deferred.make<void>();
        const seen: SpeechOutputAudio[] = [];
        let aborted = 0;
        let freshRequest = false;
        const http = makeHttp((_request, signal) =>
          Effect.sync(() => {
            if (freshRequest) return audioResponse([new Uint8Array([5, 6])]);
            freshRequest = true;
            signal.addEventListener(
              "abort",
              () => {
                aborted++;
                audio.abort();
              },
              { once: true },
            );
            return audio.response;
          }),
        );
        yield* withSpeech(storage, http.client, (speech) =>
          Effect.gen(function* () {
            const fiber = yield* speech.synthesize({ text: "Do not replay." }).pipe(
              Stream.runForEach((chunk) =>
                Effect.sync(() => {
                  seen.push(chunk);
                }).pipe(Effect.andThen(Deferred.succeed(received, undefined))),
              ),
              Effect.forkChild,
            );
            audio.push(new Uint8Array([1, 2]));
            yield* Deferred.await(received);
            yield* Fiber.interrupt(fiber);
            expect(http.signals[0]?.aborted).toBe(true);
            expect(aborted).toBe(1);
            audio.push(new Uint8Array([3, 4]));
            expect(seen).toHaveLength(1);
            expect(http.requests).toHaveLength(1);
            // An explicit new phrase is allowed after cancellation; the old phrase never reappears.
            const fresh = yield* speech
              .synthesize({ text: "Fresh phrase." })
              .pipe(Stream.runCollect);
            expect(fresh.map((chunk) => [...Buffer.from(chunk.pcm, "base64")])).toEqual([[5, 6]]);
            expect(http.requests).toHaveLength(2);
          }),
        );
      }),
  );

  it.effect("missing credentials or voice reject synthesis before a provider request", () =>
    Effect.gen(function* () {
      for (const initial of [{}, { apiKey: secret }, { voiceId: "only-voice" }]) {
        const storage = yield* memoryStorage(initial);
        const http = noRequests();
        yield* withSpeech(storage, http.client, (speech) =>
          Effect.gen(function* () {
            expectError(
              yield* speech.synthesize({ text: "Hello" }).pipe(Stream.runDrain, Effect.result),
              "not-configured",
            );
            expect(http.requests).toHaveLength(0);
          }),
        );
      }
    }),
  );

  it.effect(
    "authentication, quota, rate-limit and network failures have safe distinct typed errors",
    () =>
      Effect.gen(function* () {
        const cases: ReadonlyArray<{
          status: number;
          detail: string;
          kind: SpeechOutputError["kind"];
        }> = [
          { status: 401, detail: "invalid_api_key", kind: "authentication" },
          { status: 403, detail: "missing_permissions", kind: "authentication" },
          { status: 401, detail: "quota_exceeded", kind: "quota" },
          { status: 402, detail: "insufficient_credits", kind: "quota" },
          { status: 429, detail: "rate_limit", kind: "rate-limit" },
          { status: 500, detail: "server_error", kind: "provider" },
        ];
        for (const entry of cases) {
          const storage = yield* memoryStorage(configured);
          const http = makeHttp(() =>
            Effect.succeed(
              Response.json(
                { detail: { status: entry.detail, message: `Unsafe body ${secret}` } },
                { status: entry.status },
              ),
            ),
          );
          yield* withSpeech(storage, http.client, (speech) =>
            Effect.gen(function* () {
              expectError(
                yield* speech.synthesize({ text: "Hello" }).pipe(Stream.runDrain, Effect.result),
                entry.kind,
              );
              expect(http.requests).toHaveLength(1);
              expect(http.signals[0]?.aborted).toBe(true);
            }),
          );
        }
        const storage = yield* memoryStorage(configured);
        const http = makeHttp((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: secret,
                description: secret,
              }),
            }),
          ),
        );
        yield* withSpeech(storage, http.client, (speech) =>
          Effect.gen(function* () {
            expectError(
              yield* speech.synthesize({ text: "Hello" }).pipe(Stream.runDrain, Effect.result),
              "network",
            );
            expect(http.requests).toHaveLength(1);
            expect(http.signals[0]?.aborted).toBe(true);
          }),
        );
      }),
  );

  it.effect("malformed, empty or odd-byte final PCM fails with distinct private diagnostics", () =>
    Effect.gen(function* () {
      for (const entry of [
        {
          chunks: [new Uint8Array([1, 2])],
          type: "application/json",
          emitted: 0,
          reason: "unexpected-content-type",
          received: 0,
          emittedBytes: 0,
        },
        {
          chunks: [new Uint8Array([1])],
          type: "audio/pcm",
          emitted: 0,
          reason: "incomplete-sample",
          received: 1,
          emittedBytes: 0,
        },
        {
          chunks: [new Uint8Array([1, 2, 3])],
          type: "audio/pcm",
          emitted: 1,
          reason: "incomplete-sample",
          received: 3,
          emittedBytes: 2,
        },
        {
          chunks: [],
          type: "audio/pcm",
          emitted: 0,
          reason: "empty-stream",
          received: 0,
          emittedBytes: 0,
        },
      ]) {
        const storage = yield* memoryStorage(configured);
        const seen: SpeechOutputAudio[] = [];
        const reports: SpeechOutputDiagnostic[] = [];
        const http = makeHttp(() => Effect.succeed(audioResponse(entry.chunks, entry.type)));
        yield* withSpeech(
          storage,
          http.client,
          (speech) =>
            Effect.gen(function* () {
              expectError(
                yield* speech.synthesize({ text: "Hello" }).pipe(
                  Stream.runForEach((chunk) =>
                    Effect.sync(() => {
                      seen.push(chunk);
                    }),
                  ),
                  Effect.result,
                ),
                "invalid-audio",
              );
              expect(seen).toHaveLength(entry.emitted);
              for (const chunk of seen)
                expect(Buffer.from(chunk.pcm, "base64").byteLength % 2).toBe(0);
              expect(http.requests).toHaveLength(1);
              expect(http.signals[0]?.aborted).toBe(true);
            }),
          SpeechOutputDiagnostics.of({
            record: (report) =>
              Effect.sync(() => {
                reports.push(report);
              }),
          }),
        );
        expect(reports).toHaveLength(1);
        expect(reports[0]).toMatchObject({
          reason: entry.reason,
          errorKind: "invalid-audio",
          httpStatus: 200,
          contentType: entry.type,
          receivedBytes: entry.received,
          emittedBytes: entry.emittedBytes,
          danglingSampleByte: entry.reason === "incomplete-sample",
        });
        expect(JSON.stringify(reports)).not.toContain(secret);
        expect(JSON.stringify(reports)).not.toContain("Hello");
      }
    }),
  );

  it.effect(
    "arbitrary large HTTP chunks become bounded PCM frames without losing sample bytes",
    () =>
      Effect.gen(function* () {
        for (const type of ["audio/pcm; charset=binary", "application/octet-stream"]) {
          const storage = yield* memoryStorage(configured);
          const source = Uint8Array.from({ length: 196_612 }, (_, index) => index % 251);
          // Both a dangling byte entering a large chunk and leaving one are preserved.
          const http = makeHttp(() =>
            Effect.succeed(
              audioResponse(
                [source.subarray(0, 1), source.subarray(1, 131_077), source.subarray(131_077)],
                type,
              ),
            ),
          );
          const reports: SpeechOutputDiagnostic[] = [];
          yield* withSpeech(
            storage,
            http.client,
            (speech) =>
              Effect.gen(function* () {
                const frames = yield* speech
                  .synthesize({ text: "Private phrase" })
                  .pipe(Stream.runCollect);
                const decoded = frames.map((frame) => Buffer.from(frame.pcm, "base64"));
                expect(Buffer.concat(decoded)).toEqual(Buffer.from(source));
                for (const frame of decoded) {
                  expect(frame.byteLength).toBeGreaterThan(0);
                  expect(frame.byteLength).toBeLessThanOrEqual(65_536);
                  expect(frame.byteLength % 2).toBe(0);
                }
                expect(http.requests).toHaveLength(1);
              }),
            SpeechOutputDiagnostics.of({
              record: (report) =>
                Effect.sync(() => {
                  reports.push(report);
                }),
            }),
          );
          expect(reports).toEqual([]);
        }
      }),
  );

  it.effect(
    "real synthesis failures persist only the latest metadata report with private permissions",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFileSystem();
        const storage = yield* memoryStorage(configured);
        const logs: unknown[] = [];
        yield* Effect.gen(function* () {
          const diagnostics = yield* SpeechOutputDiagnostics;
          for (const type of ["application/json", "audio/pcm"]) {
            const response = audioResponse([], type);
            response.headers.set("request-id", "provider-request-123");
            response.headers.set("xi-api-key", secret);
            const http = makeHttp(() => Effect.succeed(response));
            yield* withSpeech(
              storage,
              http.client,
              (speech) =>
                speech
                  .synthesize({ text: "Do not log this phrase" })
                  .pipe(Stream.runDrain, Effect.result),
              diagnostics,
            );
            expect(http.requests).toHaveLength(1);
          }
          const raw = fake.files.get("private/speech/last-failure.json");
          expect(raw).toBeDefined();
          expect(JSON.parse(raw ?? "null")).toMatchObject({
            reason: "empty-stream",
            httpStatus: 200,
            providerRequestId: "provider-request-123",
            contentType: "audio/pcm",
          });
          expect([...fake.files.keys()]).toEqual(["private/speech/last-failure.json"]);
          expect(fake.permissions.get("private/speech")).toBe(0o700);
          expect(fake.permissions.get("private/speech/last-failure.json")).toBe(0o600);
          expect(raw).not.toContain(secret);
          expect(raw).not.toContain("Do not log this phrase");
          expect(raw).not.toContain(configured.voiceId);
          // Successful playback and cancellation before EOF retain the previous failure.
          for (const cancelEarly of [false, true]) {
            const http = makeHttp(() =>
              Effect.succeed(audioResponse([new Uint8Array(cancelEarly ? [1, 2, 3] : [1, 2])])),
            );
            yield* withSpeech(
              storage,
              http.client,
              (speech) => {
                const stream = speech.synthesize({ text: "Successful or interrupted phrase" });
                return (cancelEarly ? stream.pipe(Stream.take(1)) : stream).pipe(Stream.runDrain);
              },
              diagnostics,
            );
            expect(fake.files.get("private/speech/last-failure.json")).toBe(raw);
            expect(http.requests).toHaveLength(1);
            expect(http.signals[0]?.aborted).toBe(true);
          }
          // A diagnostic write failure must neither replace the synthesis error nor retry it.
          fake.controls.failRename = true;
          const http = makeHttp(() => Effect.succeed(audioResponse([])));
          expectError(
            yield* withSpeech(
              storage,
              http.client,
              (speech) =>
                speech
                  .synthesize({ text: "Another private phrase" })
                  .pipe(Stream.runDrain, Effect.result),
              diagnostics,
            ),
            "invalid-audio",
          );
          expect(http.requests).toHaveLength(1);
          expect(fake.files.get("private/speech/last-failure.json")).toBe(raw);
          expect([...fake.files.keys()]).toEqual(["private/speech/last-failure.json"]);
        }).pipe(
          Effect.provide(
            makeSpeechOutputDiagnosticsLive("private/speech").pipe(
              Layer.provide(Layer.succeed(FileSystem.FileSystem, fake.fs)),
            ),
          ),
          Effect.provide(
            Logger.layer([
              Logger.map(Logger.formatStructured, (entry) => {
                logs.push(entry);
              }),
            ]),
          ),
        );
        expect(logs.length).toBeGreaterThan(0);
        expect(JSON.stringify(logs)).not.toContain(secret);
        expect(JSON.stringify(logs)).not.toContain("private phrase");
        expect(JSON.stringify(logs)).not.toContain(configured.voiceId);
      }),
  );
});
