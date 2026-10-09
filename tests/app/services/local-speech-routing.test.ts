import { it } from "@effect/vitest";
import { describe, expect } from "vitest";
import { Effect, Layer, Queue, Stream, SubscriptionRef } from "effect";
import * as speechOutput from "../../../src/domain/speech/speech-output";
import {
  SpeechOutputError,
  type ElevenLabsSpeechSettings,
  type SpeechOutputSettings,
  type SpeechOutputAudio,
} from "../../../src/domain/speech/speech-output-data";
import { ElevenLabsSpeech } from "../../../src/services/speech/ElevenLabsSpeech";
import { PocketTts } from "../../../src/services/speech/PocketTts";
import { pocketTtsState } from "../../helpers/speech-output";

const pcm: SpeechOutputAudio = { encoding: "pcm_s16le", sampleRate: 24_000, pcm: "AAA=" };
const fixture = Effect.fn("SpeechRoutingTest.fixture")(function* () {
  const local = yield* SubscriptionRef.make(pocketTtsState({ installed: true }));
  const cloud = yield* SubscriptionRef.make<ElevenLabsSpeechSettings>({
    keyConfigured: true,
    modelId: "eleven_flash_v2_5",
    speed: 1.15,
    voiceId: "saved-cloud-voice",
    voices: [{ id: "saved-cloud-voice", name: "Saved cloud voice" }],
  });
  const calls = {
    cloud: [] as string[],
    local: [] as string[],
    localSpeeds: [] as number[],
    refreshCloud: 0,
  };
  const layer = Layer.merge(
    Layer.succeed(
      PocketTts,
      PocketTts.of({
        observeState: () => SubscriptionRef.changes(local),
        getState: () => SubscriptionRef.get(local),
        select: (selected) => SubscriptionRef.update(local, (state) => ({ ...state, selected })),
        install: () => SubscriptionRef.update(local, (state) => ({ ...state, installed: true })),
        remove: () => SubscriptionRef.update(local, (state) => ({ ...state, installed: false })),
        setSpeed: (speed) => SubscriptionRef.update(local, (state) => ({ ...state, speed })),
        synthesize: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (!(yield* SubscriptionRef.get(local)).installed)
                return yield* new SpeechOutputError({
                  kind: "not-configured",
                  message: "Download Pocket TTS first",
                });
              calls.local.push(request.text);
              calls.localSpeeds.push((yield* SubscriptionRef.get(local)).speed);
              return Stream.succeed(pcm);
            }),
          ),
      }),
    ),
    Layer.succeed(
      ElevenLabsSpeech,
      ElevenLabsSpeech.of({
        observeSettings: () => SubscriptionRef.changes(cloud),
        setApiKey: () => Effect.void,
        setVoice: (voiceId) => SubscriptionRef.update(cloud, (state) => ({ ...state, voiceId })),
        setSpeed: (speed) => SubscriptionRef.update(cloud, (state) => ({ ...state, speed })),
        listVoices: () =>
          Effect.sync(() => {
            calls.refreshCloud++;
            return [{ id: "saved-cloud-voice", name: "Saved cloud voice" }];
          }),
        synthesize: (request) =>
          Stream.unwrap(
            Effect.sync(() => {
              calls.cloud.push(request.text);
              return Stream.succeed(pcm);
            }),
          ),
      }),
    ),
  );
  return { local, cloud, calls, layer };
});
const current = () =>
  speechOutput.observeSettings().pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((values) => values[0]),
  );

describe("speech provider routing", () => {
  it.effect(
    "projects local installation facts and preserves saved cloud voice/speed through provider switches",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          expect(yield* current()).toMatchObject({
            provider: "elevenlabs",
            voiceId: "saved-cloud-voice",
            speed: 1.15,
          });
          yield* speechOutput.setProvider("pocket-tts");
          expect(yield* current()).toMatchObject({
            provider: "pocket-tts",
            modelId: "pocket-tts-8bit",
            voiceId: "alba",
            speed: 1,
            localModel: { selected: true, installed: true },
          });
          expect(yield* speechOutput.listVoices()).toEqual([{ id: "alba", name: "Alba" }]);
          yield* speechOutput.setVoice("alba");
          yield* speechOutput.setSpeed(2);
          expect(yield* current()).toMatchObject({ provider: "pocket-tts", speed: 2 });
          yield* speechOutput.setProvider("elevenlabs");
          expect(yield* current()).toMatchObject({
            provider: "elevenlabs",
            voiceId: "saved-cloud-voice",
            speed: 1.15,
          });
          yield* speechOutput.setSpeed(1.1);
          yield* speechOutput.setProvider("pocket-tts");
          expect(yield* current()).toMatchObject({ provider: "pocket-tts", speed: 2 });
          expect((yield* SubscriptionRef.get(f.cloud)).speed).toBe(1.1);
          expect(f.calls.refreshCloud).toBe(0);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect("uses only the selected provider and never falls back to a billed cloud request", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.gen(function* () {
        yield* speechOutput.setProvider("pocket-tts");
        expect(
          yield* speechOutput.synthesize({ text: "Local reply." }).pipe(Stream.runCollect),
        ).toEqual([pcm]);
        expect(f.calls.localSpeeds).toEqual([1]);
        yield* speechOutput.setSpeed(2);
        yield* speechOutput.synthesize({ text: "Faster local reply." }).pipe(Stream.runDrain);
        expect(f.calls.localSpeeds).toEqual([1, 2]);
        yield* SubscriptionRef.update(f.local, (state) => ({ ...state, installed: false }));
        const failure = yield* speechOutput
          .synthesize({ text: "Unready local reply." })
          .pipe(Stream.runCollect, Effect.result);
        expect(failure._tag).toBe("Failure");
        expect(f.calls.cloud).toEqual([]);
        expect(f.calls.local).toEqual(["Local reply.", "Faster local reply."]);
        yield* speechOutput.setProvider("elevenlabs");
        yield* speechOutput.synthesize({ text: "Cloud reply." }).pipe(Stream.runDrain);
        expect(f.calls.cloud).toEqual(["Cloud reply."]);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect(
    "keeps one settings observer current through installation progress and completion",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* speechOutput.setProvider("pocket-tts");
          const snapshots = yield* Queue.unbounded<SpeechOutputSettings>();
          yield* speechOutput.observeSettings().pipe(
            Stream.runForEach((value) => Queue.offer(snapshots, value)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(snapshots)).toMatchObject({ localModel: { installing: false } });
          yield* SubscriptionRef.update(f.local, (state) => ({
            ...state,
            installed: false,
            installing: true,
            downloadedBytes: 10_000_000,
          }));
          expect(yield* Queue.take(snapshots)).toMatchObject({
            provider: "pocket-tts",
            localModel: { installed: false, installing: true, downloadedBytes: 10_000_000 },
          });
          yield* SubscriptionRef.update(f.local, (state) => ({
            ...state,
            installed: true,
            installing: false,
            downloadedBytes: state.totalBytes,
          }));
          expect(yield* Queue.take(snapshots)).toMatchObject({
            provider: "pocket-tts",
            localModel: { installed: true, installing: false },
          });
        }).pipe(Effect.provide(f.layer));
      }),
  );
});
