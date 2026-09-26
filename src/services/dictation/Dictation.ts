import { Context, type Effect, type Stream } from "effect";
import type {
  DictationAudio,
  DictationError,
  DictationState,
} from "../../domain/dictation/dictation-data";

/** Main-owned installation and one warm local inference process. Audio is ephemeral. */
export class Dictation extends Context.Service<
  Dictation,
  {
    readonly observeState: () => Stream.Stream<DictationState>;
    readonly install: () => Effect.Effect<void, DictationError>;
    readonly setModelPath: (path: string) => Effect.Effect<void, DictationError>;
    readonly remove: () => Effect.Effect<void, DictationError>;
    readonly prepare: () => Effect.Effect<void, DictationError>;
    readonly release: () => Effect.Effect<void, DictationError>;
    readonly transcribe: (audio: DictationAudio) => Effect.Effect<string, DictationError>;
  }
>()("cake/services/dictation/Dictation") {}
