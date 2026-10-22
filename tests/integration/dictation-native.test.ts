import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { VocabularyEntry } from "../../src/contracts/dictation/vocabulary";
import { describe, expect, test } from "vitest";
import { ParakeetWorker, validateModel } from "../../src/services/dictation/local-parakeet";

const model = process.env.CAKE_DICTATION_TEST_MODEL;
const ctc = process.env.CAKE_DICTATION_TEST_CTC;
const run = promisify(execFile);

async function syntheticSpeech(root: string, name: string, text: string) {
  const aiff = join(root, `${name}.aiff`),
    wavPath = join(root, `${name}.wav`);
  await run("/usr/bin/say", ["-v", "Samantha", "-o", aiff, text]);
  await run("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEF32@16000", "-c", "1", aiff, wavPath]);
  const wav = await readFile(wavPath);
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data")
      return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("Synthetic WAV is missing PCM audio");
}
function generatedPcm(samples: number, sample: (index: number) => number) {
  const pcm = Buffer.alloc(samples * 4);
  for (let i = 0; i < samples; i++) pcm.writeFloatLE(sample(i), i * 4);
  return pcm;
}
async function stream(
  worker: ParakeetWorker,
  id: string,
  pcm: Buffer,
  vocabulary: readonly VocabularyEntry[] = [],
) {
  const partials: string[] = [];
  for (let offset = 0; offset < pcm.length; offset += 51_200)
    partials.push(
      await worker.transcribe(
        {
          utteranceId: id,
          pcm: pcm.subarray(offset, offset + 51_200).toString("base64"),
          final: false,
        },
        vocabulary,
      ),
    );
  return partials;
}
async function fixture() {
  if (!model) throw new Error("CAKE_DICTATION_TEST_MODEL is required");
  await validateModel(model);
  const root = await mkdtemp(join(tmpdir(), "cake-native-dictation-"));
  const worker = new ParakeetWorker(
    process.env.CAKE_DICTATION_TEST_HELPER ?? resolve("out/main/native/cake-dictation"),
    model,
    ctc ?? join(root, "ctc"),
  );
  return {
    root,
    worker,
    async [Symbol.asyncDispose]() {
      worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// Real bundled Core ML models, explicit opt-in, synthetic speech only: never a live microphone.
// pnpm build && CAKE_DICTATION_TEST_MODEL=/path/to/model pnpm test:integration tests/integration/dictation-native.test.ts
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !model)(
  "native speech input",
  () => {
    // Both model paths are explicit opt-ins. This test never downloads or changes user data.
    test.skipIf(!ctc)(
      "acoustically corrects a known name while preserving legitimate banks, live revisions and raw finalization",
      async () => {
        await using f = await fixture();
        await f.worker.ready;
        const vocabulary = [{ id: "review-agent", text: "Binks", aliases: ["Banks", "Vinx"] }];
        const pcm = await syntheticSpeech(f.root, "known-name", "Ask Binks to review the changes.");
        await stream(f.worker, "default", pcm);
        const baseline = await f.worker.transcribe({
          utteranceId: "default",
          pcm: "",
          final: true,
        });
        await f.worker.prepareVocabulary();
        const partials = await stream(f.worker, "boosted", pcm, vocabulary);
        expect(partials.some((text) => /\bBinks\b/.test(text))).toBe(true);
        // A settings change during this utterance must not discard its captured vocabulary.
        const final = await f.worker.transcribe(
          { utteranceId: "boosted", pcm: "", final: true },
          [],
        );
        expect(final.match(/\bBinks\b/g)).toHaveLength(1);
        expect(final.match(/review/g)).toHaveLength(1);
        expect(final).not.toBe(baseline);
        const banks = await syntheticSpeech(
          f.root,
          "ordinary-banks",
          "The banks are closed on Sunday. The river banks are covered with flowers.",
        );
        await stream(f.worker, "banks", banks, vocabulary);
        const ordinary = await f.worker.transcribe(
          { utteranceId: "banks", pcm: "", final: true },
          vocabulary,
        );
        expect(ordinary.match(/\bbanks\b/gi)).toHaveLength(2);
        expect(ordinary).not.toMatch(/\bBinks\b/i);
        await stream(f.worker, "empty-again", pcm);
        expect(
          await f.worker.transcribe({ utteranceId: "empty-again", pcm: "", final: true }),
        ).toBe(baseline);
      },
      180_000,
    );

    test("warms offline, revises streaming words, finalizes and isolates new focus", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const pcm = await syntheticSpeech(
        f.root,
        "speech",
        "The quick brown fox jumps over the lazy dog. This is local voice input in Cake.",
      );
      const partials = await stream(f.worker, "first-focus", pcm);
      expect(partials.some((text) => /quick brown fox/i.test(text))).toBe(true);
      const final = await f.worker.transcribe({ utteranceId: "first-focus", pcm: "", final: true });
      expect(final).toMatch(/quick brown fox jumps over the lazy dog/i);
      // The real recognizer can hear synthesized "in" as "and". Both retain the final word;
      // this is an endpoint regression, not a claim of zero transcription word error.
      expect(final).toMatch(/local voice input (?:in|and) cake/i);
      await f.worker.transcribe({
        utteranceId: "abandoned",
        pcm: pcm.subarray(0, 51_200).toString("base64"),
        final: false,
      });
      expect(await f.worker.transcribe({ utteranceId: "new-focus", pcm: "", final: true })).toBe(
        "",
      );
    }, 180_000);

    test("silence, hum, steady noise and isolated clicks do not produce words or voice activity", async () => {
      await using f = await fixture();
      await f.worker.ready;
      let seed = 42;
      const noises = [
        generatedPcm(6 * 16000, () => 0),
        generatedPcm(6 * 16000, (i) => 0.08 * Math.sin((2 * Math.PI * 120 * i) / 16000)),
        generatedPcm(6 * 16000, () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return ((seed / 4294967296) * 2 - 1) * 0.1;
        }),
        generatedPcm(6 * 16000, (i) => (i % 16000 < 80 ? 0.3 * Math.sin(i) : 0)),
      ];
      for (const [index, noise] of noises.entries()) {
        const id = `noise-${index}`;
        expect((await stream(f.worker, id, noise)).every((text) => text === "")).toBe(true);
        expect(await f.worker.transcribe({ utteranceId: id, pcm: "", final: true })).toBe("");
        const detections: boolean[] = [];
        for (let offset = 0; offset < noise.length; offset += 4096 * 4)
          detections.push(
            await f.worker.detectSpeech({
              captureId: id,
              pcm: noise.subarray(offset, offset + 4096 * 4).toString("base64"),
            }),
          );
        expect(detections.some(Boolean), `Noise case ${index} must not trigger voice mode`).toBe(
          false,
        );
      }
    }, 180_000);

    test("pauses do not create noise transcripts and resumed speech is assembled exactly once", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const first = await syntheticSpeech(
        f.root,
        "first",
        "The quick brown fox jumps over the lazy dog.",
      );
      const second = await syntheticSpeech(f.root, "second", "This is local voice input in Cake.");
      await stream(f.worker, "same-field", first);
      const pause = generatedPcm(
        4 * 16000,
        (i) => 0.08 * Math.sin((2 * Math.PI * 120 * i) / 16000),
      );
      const duringPause = await stream(f.worker, "same-field", pause);
      const sealed = duringPause.at(-1);
      expect(sealed).toMatch(/quick brown fox jumps over the lazy dog/i);
      expect(duringPause.slice(-2)).toEqual([sealed, sealed]);
      await stream(f.worker, "same-field", second);
      const final = await f.worker.transcribe({ utteranceId: "same-field", pcm: "", final: true });
      expect(final.match(/quick brown fox/gi)).toHaveLength(1);
      expect(final.match(/local voice input in cake/gi)).toHaveLength(1);
    }, 180_000);

    test("re-decodes a sentence across a long thinking pause without freezing a false sentence ending", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const first = await syntheticSpeech(f.root, "question-start", "Could you take a look at");
      const second = await syntheticSpeech(
        f.root,
        "question-end",
        "how we put together the different parts of streaming transcription?",
      );
      const partials = await stream(f.worker, "thinking-pause", first);
      expect(partials.some((text) => /take a look/i.test(text))).toBe(true);
      const silence = await stream(
        f.worker,
        "thinking-pause",
        generatedPcm(4 * 16000, () => 0),
      );
      expect(silence.slice(-2)[0]).toBe(silence.at(-1));
      await stream(f.worker, "thinking-pause", second);
      const final = await f.worker.transcribe({
        utteranceId: "thinking-pause",
        pcm: "",
        final: true,
      });
      expect(final).toMatch(/could you take a look at how we put together/i);
      expect(final.match(/take a look/gi)).toHaveLength(1);
      expect(final).toMatch(/different parts of streaming transcription\?/i);
    }, 180_000);

    test("retains every passage across rolling-window seams during long continuous speech", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const sentences = [
        "The quick brown fox jumps over the lazy dog.",
        "We need more context for the recognition model to understand the sentence.",
        "Recent words should change as the speaker continues talking about the implementation.",
        "The older passage should remain stable while the final question is still being spoken.",
        "Can you explain how the different parts of streaming transcription fit together?",
      ];
      const pcm = await syntheticSpeech(f.root, "long-speech", sentences.join(" "));
      expect(pcm.length / 4 / 16000).toBeGreaterThan(20);
      await stream(f.worker, "long-speech", pcm);
      const final = await f.worker.transcribe({ utteranceId: "long-speech", pcm: "", final: true });
      for (const phrase of [
        "quick brown fox",
        "recognition model",
        "recent words",
        "older passage",
        "different parts",
      ])
        expect(final.match(new RegExp(phrase, "gi")), phrase).toHaveLength(1);
      expect(final).toMatch(/fit together\?/i);
    }, 180_000);

    test("finalizes a short spoken command even when submitted immediately", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const stop = await syntheticSpeech(f.root, "stop", "Stop!");
      await stream(f.worker, "short-command", stop);
      expect(
        await f.worker.transcribe({ utteranceId: "short-command", pcm: "", final: true }),
      ).toMatch(/\bstop\b/i);
    }, 180_000);

    test("detects and transcribes quieter speech without changing words or clipping endpoints", async () => {
      await using f = await fixture();
      await f.worker.ready;
      const original = await syntheticSpeech(
        f.root,
        "quiet",
        "The quick brown fox jumps over the lazy dog.",
      );
      const quiet = generatedPcm(original.length / 4, (i) => original.readFloatLE(i * 4) * 0.1);
      const detections: boolean[] = [];
      for (let offset = 0; offset < quiet.length; offset += 4096 * 4)
        detections.push(
          await f.worker.detectSpeech({
            captureId: "quiet",
            pcm: quiet.subarray(offset, offset + 4096 * 4).toString("base64"),
          }),
        );
      expect(detections.some(Boolean)).toBe(true);
      await stream(f.worker, "quiet", quiet);
      expect(await f.worker.transcribe({ utteranceId: "quiet", pcm: "", final: true })).toMatch(
        /quick brown fox jumps over the lazy dog/i,
      );
      // A new capture must not inherit speech hysteresis or recurrent state.
      expect(
        await f.worker.detectSpeech({
          captureId: "new-capture",
          pcm: Buffer.alloc(4096 * 4).toString("base64"),
        }),
      ).toBe(false);
    }, 180_000);
  },
);
