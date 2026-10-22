import {
  VocabularyChange,
  VocabularyListInput,
  VocabularyPage,
} from "../../contracts/dictation/vocabulary";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DictationAudio,
  DictationError,
  DictationState,
  SpeechDetectionAudio,
} from "../../contracts/dictation/dictation-data";

export const DictationRpc = RpcGroup.make(
  Rpc.make("dictation.listVocabulary", {
    payload: VocabularyListInput,
    success: VocabularyPage,
    error: DictationError,
  }),
  Rpc.make("dictation.changeVocabulary", {
    payload: VocabularyChange,
    success: Schema.Struct({ revision: Schema.Int }),
    error: DictationError,
  }),
  Rpc.make("dictation.installVocabulary", { success: Schema.Void, error: DictationError }),
  Rpc.make("dictation.observeState", { success: DictationState, stream: true }),
  Rpc.make("dictation.install", { success: Schema.Void, error: DictationError }),
  Rpc.make("dictation.setModelPath", {
    payload: { path: Schema.String },
    success: Schema.Void,
    error: DictationError,
  }),
  Rpc.make("dictation.remove", { success: Schema.Void, error: DictationError }),
  Rpc.make("dictation.prepare", { success: Schema.Void, error: DictationError }),
  Rpc.make("dictation.release", { success: Schema.Void, error: DictationError }),
  Rpc.make("dictation.detectSpeech", {
    payload: SpeechDetectionAudio,
    success: Schema.Boolean,
    error: DictationError,
  }),
  Rpc.make("dictation.transcribe", {
    payload: DictationAudio,
    success: Schema.String,
    error: DictationError,
  }),
);
