import { Schema } from "effect";
import { SpeechOutputProvider } from "../../domain/speech/pocket-tts-data";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  SpeechOutputAudio,
  SpeechOutputError,
  SpeechOutputRequest,
  SpeechOutputSettings,
  SpeechOutputSpeed,
  SpeechOutputVoice,
} from "../../domain/speech/speech-output-data";

/** Native-only desktop group. Streaming synthesis is a command, not a retried observation. */
export const SpeechOutputRpc = RpcGroup.make(
  Rpc.make("speechOutput.observeSettings", {
    success: SpeechOutputSettings,
    error: SpeechOutputError,
    stream: true,
  }),
  Rpc.make("speechOutput.setProvider", {
    payload: { provider: SpeechOutputProvider },
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.installLocal", {
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.removeLocal", {
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.setApiKey", {
    payload: {
      key: Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096))),
    },
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.setVoice", {
    payload: { voiceId: SpeechOutputVoice.fields.id },
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.setSpeed", {
    payload: { speed: SpeechOutputSpeed },
    success: Schema.Void,
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.listVoices", {
    success: Schema.Array(SpeechOutputVoice).check(Schema.isMaxLength(1_000)),
    error: SpeechOutputError,
  }),
  Rpc.make("speechOutput.synthesize", {
    payload: SpeechOutputRequest,
    success: SpeechOutputAudio,
    error: SpeechOutputError,
    stream: true,
  }),
);
