import { Context, type Effect, type Stream } from "effect";
import type { PocketTtsState } from "./pocket-tts-data";
import type {
  SpeechOutputAudio,
  SpeechOutputError,
  SpeechOutputRequest,
} from "./speech-output-data";

/** Native main owns installation, selection and one warm, serial inference process.
 * Stream cancellation kills active inference; the next explicit request reloads the helper.
 */
export class PocketTts extends Context.Service<
  PocketTts,
  {
    readonly observeState: () => Stream.Stream<PocketTtsState>;
    readonly getState: () => Effect.Effect<PocketTtsState>;
    readonly select: (selected: boolean) => Effect.Effect<void, SpeechOutputError>;
    readonly setSpeed: (speed: number) => Effect.Effect<void, SpeechOutputError>;
    readonly install: () => Effect.Effect<void, SpeechOutputError>;
    readonly remove: () => Effect.Effect<void, SpeechOutputError>;
    readonly synthesize: (
      request: SpeechOutputRequest,
    ) => Stream.Stream<SpeechOutputAudio, SpeechOutputError>;
  }
>()("cake/services/speech/PocketTts") {}
