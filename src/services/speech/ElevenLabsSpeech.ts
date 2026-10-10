import { Context, type Effect, type Stream } from "effect";
import type {
  SpeechOutputAudio,
  SpeechOutputError,
  SpeechOutputRequest,
  ElevenLabsSpeechSettings,
  SpeechOutputVoice,
} from "../../contracts/speech/speech-output-data";

/** Native desktop main owns encrypted credentials, settings and outbound ElevenLabs requests.
 * Each synthesis stream owns its request; cancellation closes it. No automatic retry/rebilling.
 * Backend/Pi ownership is unchanged; this service is not acquired by the headless backend.
 */
export class ElevenLabsSpeech extends Context.Service<
  ElevenLabsSpeech,
  {
    readonly observeSettings: () => Stream.Stream<ElevenLabsSpeechSettings, SpeechOutputError>;
    readonly setApiKey: (key: string | null) => Effect.Effect<void, SpeechOutputError>;
    readonly setVoice: (voiceId: string) => Effect.Effect<void, SpeechOutputError>;
    readonly setSpeed: (speed: number) => Effect.Effect<void, SpeechOutputError>;
    readonly listVoices: () => Effect.Effect<ReadonlyArray<SpeechOutputVoice>, SpeechOutputError>;
    readonly synthesize: (
      request: SpeechOutputRequest,
    ) => Stream.Stream<SpeechOutputAudio, SpeechOutputError>;
  }
>()("cake/services/speech/ElevenLabsSpeech") {}
