import {
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
  type Types,
} from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import {
  SpeechOutputError,
  SpeechOutputRequest,
  type SpeechOutputSettings,
  SpeechOutputVoice,
  type SpeechOutputAudio,
} from "../../domain/speech/speech-output-data";
import { ElevenLabsSpeech } from "./ElevenLabsSpeech";
import { SpeechOutputStorage, StoredSpeechOutputSettings } from "./SpeechOutputStorage";

const networkError = () =>
  new SpeechOutputError({
    kind: "network",
    message:
      "Could not connect to ElevenLabs. Check your connection and re-enter conversation mode to try again.",
  });
const invalidAudio = () =>
  new SpeechOutputError({
    kind: "invalid-audio",
    message: "ElevenLabs returned invalid PCM audio. No automatic retry was made.",
  });
const notConfigured = () =>
  new SpeechOutputError({
    kind: "not-configured",
    message: "Configure an ElevenLabs API key and select a voice in Speech output settings.",
  });
const providerError = () =>
  new SpeechOutputError({
    kind: "provider",
    message: "ElevenLabs could not complete this request. No automatic retry was made.",
  });
const project = (settings: StoredSpeechOutputSettings): SpeechOutputSettings => {
  const snapshot: Types.Mutable<SpeechOutputSettings> = {
    keyConfigured: settings.apiKey !== undefined,
    modelId: "eleven_flash_v2_5",
  };
  if (settings.voiceId !== undefined) snapshot.voiceId = settings.voiceId;
  return snapshot;
};
const voices = Schema.Struct({
  voices: Schema.Array(
    Schema.Struct({ voice_id: SpeechOutputVoice.fields.id, name: SpeechOutputVoice.fields.name }),
  ).check(Schema.isMaxLength(1_000)),
});
const errorDetail = Schema.fromJsonString(
  Schema.Struct({
    detail: Schema.Struct({ status: Schema.String }),
  }),
);

/** Read only a bounded provider error envelope, discard raw bodies and never expose them. */
const checkStatus = Effect.fn("ElevenLabsSpeech.checkStatus")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  if (response.status >= 200 && response.status < 300) return;
  const detail = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => Buffer.alloc(0),
      (body, bytes) =>
        body.byteLength + bytes.byteLength > 16_384
          ? Effect.fail(providerError())
          : Effect.succeed(Buffer.concat([body, bytes])),
    ),
    Effect.flatMap((body) => Schema.decodeUnknownEffect(errorDetail)(body.toString("utf8"))),
    Effect.map((body) => body.detail.status),
    Effect.catch(() => Effect.succeed(undefined)),
  );
  if (response.status === 402 || detail === "quota_exceeded" || detail === "insufficient_credits") {
    return yield* new SpeechOutputError({
      kind: "quota",
      message: "ElevenLabs quota is exhausted. Check your provider account before trying again.",
    });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new SpeechOutputError({
      kind: "authentication",
      message: "ElevenLabs rejected your API key or its permissions. Check Speech output settings.",
    });
  }
  if (response.status === 429) {
    return yield* new SpeechOutputError({
      kind: "rate-limit",
      message: "ElevenLabs rate limited this request. Wait before explicitly trying again.",
    });
  }
  return yield* providerError();
});

/** Main owns settings for the process lifetime. All settings operations serialize; loading is
 * lazy so optional filesystem/encryption errors cannot prevent startup. Requests are scoped,
 * sequential and single-execution; neither service nor stream retries billed synthesis.
 */
export const ElevenLabsSpeechLive: Layer.Layer<
  ElevenLabsSpeech,
  never,
  SpeechOutputStorage | HttpClient.HttpClient
> = Layer.effect(
  ElevenLabsSpeech,
  Effect.gen(function* () {
    const storage = yield* SpeechOutputStorage;
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const settingsLock = yield* Semaphore.make(1);
    const synthesisLock = yield* Semaphore.make(1);
    const settings = yield* Ref.make(Option.none<StoredSpeechOutputSettings>());
    const projection = yield* SubscriptionRef.make(Option.none<SpeechOutputSettings>());

    const readSettings = Effect.fn("ElevenLabsSpeech.readSettings")(function* () {
      const current = yield* Ref.get(settings);
      if (Option.isSome(current)) return current.value;
      const loaded = yield* storage.load();
      yield* Effect.gen(function* () {
        yield* Ref.set(settings, Option.some(loaded));
        yield* SubscriptionRef.set(projection, Option.some(project(loaded)));
      }).pipe(Effect.uninterruptible);
      return loaded;
    });
    const saveSettings = Effect.fn("ElevenLabsSpeech.saveSettings")(function* (
      next: StoredSpeechOutputSettings,
    ) {
      // Once persistence starts, publish the same authoritative state even if the caller exits.
      yield* storage.save(next);
      yield* Ref.set(settings, Option.some(next));
      yield* SubscriptionRef.set(projection, Option.some(project(next)));
    }, Effect.uninterruptible);
    const setApiKey = Effect.fn("ElevenLabsSpeech.setApiKey")(function* (key: string | null) {
      const current = yield* readSettings();
      const updated: Types.Mutable<StoredSpeechOutputSettings> = {};
      if (current.voiceId !== undefined) updated.voiceId = current.voiceId;
      if (key !== null) updated.apiKey = key;
      const next = yield* Schema.decodeUnknownEffect(StoredSpeechOutputSettings)(updated).pipe(
        Effect.mapError(notConfigured),
      );
      yield* saveSettings(next);
    }, settingsLock.withPermit);
    const setVoice = Effect.fn("ElevenLabsSpeech.setVoice")(function* (voiceId: string) {
      const current = yield* readSettings();
      const next = yield* Schema.decodeUnknownEffect(StoredSpeechOutputSettings)({
        ...current,
        voiceId,
      }).pipe(Effect.mapError(notConfigured));
      yield* saveSettings(next);
    }, settingsLock.withPermit);
    const observeSettings = () =>
      Stream.unwrap(
        settingsLock.withPermit(readSettings()).pipe(
          Effect.as(
            SubscriptionRef.changes(projection).pipe(
              Stream.filter(Option.isSome),
              Stream.map((value) => value.value),
            ),
          ),
        ),
      );
    const execute = Effect.fn("ElevenLabsSpeech.execute")(function* (
      request: HttpClientRequest.HttpClientRequest,
    ) {
      const redacted = yield* Headers.CurrentRedactedNames;
      const response = yield* client
        .execute(request)
        .pipe(
          Effect.provideService(Headers.CurrentRedactedNames, [...redacted, "xi-api-key"]),
          Effect.mapError(networkError),
        );
      yield* checkStatus(response);
      return response;
    });
    const listVoices = Effect.fn("ElevenLabsSpeech.listVoices")(function* () {
      const current = yield* settingsLock.withPermit(readSettings());
      if (current.apiKey === undefined) return yield* notConfigured();
      const response = yield* execute(
        HttpClientRequest.get("https://api.elevenlabs.io/v1/voices").pipe(
          HttpClientRequest.setHeader("xi-api-key", current.apiKey),
          HttpClientRequest.acceptJson,
        ),
      );
      const body = yield* response.json.pipe(Effect.mapError(networkError));
      const decoded = yield* Schema.decodeUnknownEffect(voices)(body).pipe(
        Effect.mapError(providerError),
      );
      return decoded.voices.map((voice) => ({ id: voice.voice_id, name: voice.name }));
    }, Effect.scoped);
    const synthesize = (
      request: SpeechOutputRequest,
    ): Stream.Stream<SpeechOutputAudio, SpeechOutputError> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(synthesisLock.take(1), () => synthesisLock.release(1));
          const current = yield* settingsLock.withPermit(readSettings());
          if (current.apiKey === undefined || current.voiceId === undefined)
            return yield* notConfigured();
          yield* Schema.decodeUnknownEffect(SpeechOutputRequest)(request).pipe(
            Effect.mapError(providerError),
          );
          const response = yield* execute(
            HttpClientRequest.post(
              `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(current.voiceId)}/stream`,
            ).pipe(
              HttpClientRequest.setUrlParams({ output_format: "pcm_24000" }),
              HttpClientRequest.setHeader("xi-api-key", current.apiKey),
              HttpClientRequest.setHeader("accept", "audio/pcm"),
              HttpClientRequest.bodyJsonUnsafe({
                text: request.text,
                model_id: "eleven_flash_v2_5",
              }),
            ),
          );
          const contentType = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
          if (contentType !== "audio/pcm" && contentType !== "application/octet-stream")
            return yield* invalidAudio();
          // Keep only a dangling sample byte between pulls; no whole-phrase audio collection.
          let pending: number | undefined;
          let emitted = false;
          return response.stream.pipe(
            Stream.mapError(networkError),
            Stream.flatMap((bytes) => {
              if (bytes.byteLength > 65_536) return Stream.fail(invalidAudio());
              const data =
                pending === undefined
                  ? Buffer.from(bytes)
                  : Buffer.concat([Buffer.from([pending]), bytes]);
              const alignedLength = data.byteLength - (data.byteLength % 2);
              pending = data.byteLength % 2 === 0 ? undefined : data[data.byteLength - 1];
              if (alignedLength === 0) return Stream.empty;
              emitted = true;
              return Stream.succeed<SpeechOutputAudio>({
                encoding: "pcm_s16le",
                sampleRate: 24_000,
                pcm: data.subarray(0, alignedLength).toString("base64"),
              });
            }),
            Stream.concat(
              Stream.unwrap(
                Effect.sync(() =>
                  pending !== undefined || !emitted ? Stream.fail(invalidAudio()) : Stream.empty,
                ),
              ),
            ),
          );
        }).pipe(Effect.withSpan("ElevenLabsSpeech.synthesize")),
      );
    return ElevenLabsSpeech.of({ observeSettings, setApiKey, setVoice, listVoices, synthesize });
  }),
);
