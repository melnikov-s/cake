import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SpeechDetectionAudio,
  SpeechDetectionThresholds,
  SpeechRecognitionSettings,
  DictationAudio,
} from "../../src/domain/dictation/dictation-data";

describe("speech detection threshold contract", () => {
  it("accepts intrinsic detector defaults and explicit shared thresholds", () => {
    const decode = Schema.decodeUnknownSync(SpeechDetectionAudio);
    const input = { captureId: "capture", pcm: "AAAAAA==" };
    expect(decode(input)).toEqual(input);
    const tuned = { ...input, thresholds: { start: 0.85, continuation: 0.7 } };
    expect(decode(tuned)).toEqual(tuned);
  });
  it("carries shared recognition settings on PCM requests for either workflow", () => {
    const input = {
      utteranceId: "capture",
      pcm: "AAAAAA==",
      final: false,
      settings: {
        thresholds: { start: 0.85, continuation: 0.5 },
        minimumSpeechMs: 1000,
        prerollMs: 300,
        maximumUtteranceSeconds: 5,
      },
    };
    expect(Schema.decodeUnknownSync(DictationAudio)(input)).toEqual(input);
  });
  it.each([
    { minimumSpeechMs: 99 },
    { minimumSpeechMs: 1001 },
    { prerollMs: -1 },
    { prerollMs: 1001 },
    { maximumUtteranceSeconds: 4 },
    { maximumUtteranceSeconds: 61 },
    { minimumSpeechMs: 200.5 },
  ])("rejects out-of-contract shared recognition settings: %j", (invalid) => {
    const settings = {
      thresholds: { start: 0.6, continuation: 0.4 },
      minimumSpeechMs: 200,
      prerollMs: 600,
      maximumUtteranceSeconds: 30,
      ...invalid,
    };
    expect(Option.isNone(Schema.decodeUnknownOption(SpeechRecognitionSettings)(settings))).toBe(
      true,
    );
  });
  it.each([
    { start: Number.NaN, continuation: 0.4 },
    { start: Number.POSITIVE_INFINITY, continuation: 0.4 },
    { start: 1, continuation: 0.4 },
    { start: 0.6, continuation: 0 },
    { start: 0.4, continuation: 0.6 },
  ])("rejects unbounded or inverted thresholds: %j", (thresholds) => {
    expect(Option.isNone(Schema.decodeUnknownOption(SpeechDetectionThresholds)(thresholds))).toBe(
      true,
    );
  });
});
