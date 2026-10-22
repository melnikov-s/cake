import type {
  VocabularyChange,
  VocabularyListInput,
  VocabularyPage,
} from "../../contracts/dictation/vocabulary";
import { Context, type Effect, type Stream } from "effect";
import type {
  DictationAudio,
  DictationError,
  DictationState,
  SpeechDetectionAudio,
} from "../../contracts/dictation/dictation-data";

/** Main-owned installation and one warm local inference process. Audio is ephemeral. */
export class Dictation extends Context.Service<
  Dictation,
  {
    readonly observeState: () => Stream.Stream<DictationState>;
    readonly listVocabulary: (
      input: typeof VocabularyListInput.Type,
    ) => Effect.Effect<typeof VocabularyPage.Type, DictationError>;
    readonly changeVocabulary: (
      change: VocabularyChange,
    ) => Effect.Effect<{ revision: number }, DictationError>;
    readonly installVocabulary: () => Effect.Effect<void, DictationError>;
    readonly install: () => Effect.Effect<void, DictationError>;
    readonly setModelPath: (path: string) => Effect.Effect<void, DictationError>;
    readonly remove: () => Effect.Effect<void, DictationError>;
    readonly prepare: () => Effect.Effect<void, DictationError>;
    readonly release: () => Effect.Effect<void, DictationError>;
    readonly transcribe: (audio: DictationAudio) => Effect.Effect<string, DictationError>;
    readonly detectSpeech: (audio: SpeechDetectionAudio) => Effect.Effect<boolean, DictationError>;
  }
>()("cake/services/dictation/Dictation") {}
