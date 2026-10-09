import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { PocketTtsWorker } from "../../src/services/speech/pocket-tts-worker";
import type { SpeechOutputAudio } from "../../src/domain/speech/speech-output-data";

const model = process.env.CAKE_SPEECH_TEST_MODEL;

// Explicit opt-in: pinned fp16 Core ML assets and compiled helper, no microphone/network.
// pnpm build:speech && CAKE_SPEECH_TEST_MODEL=/path/to/model pnpm test:integration tests/integration/pocket-tts-native.test.ts
test.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !model)(
  "bundled FluidAudio Pocket TTS loads offline, streams non-silent PCM, and supports cancellation/reload",
  async () => {
    if (!model) throw new Error("Set CAKE_SPEECH_TEST_MODEL to a local model directory");
    const executable = resolve("out/main/native/cake-speech");
    const worker = new PocketTtsWorker(executable, model);
    const frames: SpeechOutputAudio[] = [];
    try {
      await worker.ready;
      await worker.synthesize(
        "Hello, this isn’t a cloud service; it’s Cake speaking locally on your Mac.",
        2,
        new AbortController().signal,
        (frame) => frames.push(frame),
      );
      expect(frames.length).toBeGreaterThan(1);
      const buffers = frames.map((frame) => {
        expect(frame.encoding).toBe("pcm_s16le");
        expect(frame.sampleRate).toBe(24_000);
        const bytes = Buffer.from(frame.pcm, "base64");
        expect(bytes.length % 2).toBe(0);
        expect(bytes.length).toBeLessThanOrEqual(65_536);
        return bytes;
      });
      const pcm = Buffer.concat(buffers);
      expect(pcm.length).toBeGreaterThan(2_400);
      expect(pcm.some((byte) => byte !== 0)).toBe(true);
      const cancellation = new AbortController();
      await expect(
        worker.synthesize("Cancel this generated phrase.", 2, cancellation.signal, () =>
          cancellation.abort(),
        ),
      ).rejects.toThrow();
    } finally {
      worker.close();
    }
    const fresh = new PocketTtsWorker(executable, model);
    try {
      await fresh.ready;
      let samples = 0;
      await fresh.synthesize(
        "A fresh request works after cancellation.",
        1,
        new AbortController().signal,
        (frame) => {
          const bytes = Buffer.from(frame.pcm, "base64");
          // 1× output must retain the native 80ms frame boundary, not wait for
          // a phrase-sized array and then split it into 16K-sample chunks.
          expect(bytes.length).toBe(1_920 * 2);
          samples += bytes.length / 2;
        },
      );
      expect(samples).toBeGreaterThan(1_200);
    } finally {
      fresh.close();
    }
  },
  180_000,
);

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !model)(
  "an incomplete Core ML installation fails before entering FluidAudio download paths",
  async () => {
    const empty = await mkdtemp(join(tmpdir(), "cake-pocket-incomplete-"));
    const worker = new PocketTtsWorker(resolve("out/main/native/cake-speech"), empty);
    try {
      await expect(worker.ready).rejects.toThrow("local speech engine stopped");
    } finally {
      worker.close();
      await rm(empty, { recursive: true, force: true });
    }
  },
);
