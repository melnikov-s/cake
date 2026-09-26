import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { ParakeetWorker, validateModel } from "../../src/services/dictation/local-parakeet";

const model = process.env.CAKE_DICTATION_TEST_MODEL;
const run = promisify(execFile);

// Explicit opt-in: real Core ML inference, with synthetic speech and no live microphone.
// pnpm build && CAKE_DICTATION_TEST_MODEL=/path/to/model pnpm test:integration tests/integration/dictation-native.test.ts
test.skipIf(process.platform !== "darwin" || process.arch !== "arm64" || !model)(
  "bundled Core ML engine warms offline, revises streaming words, finalizes, and isolates new focus",
  async () => {
    await validateModel(model!);
    const root = await mkdtemp(join(tmpdir(), "cake-native-dictation-"));
    const worker = new ParakeetWorker(resolve("out/main/native/cake-dictation"), model!);
    try {
      await worker.ready;
      const aiff = join(root, "synthetic.aiff"),
        wavPath = join(root, "synthetic.wav");
      await run("/usr/bin/say", [
        "-v",
        "Samantha",
        "-o",
        aiff,
        "The quick brown fox jumps over the lazy dog. This is local voice input in Cake.",
      ]);
      await run("/usr/bin/afconvert", [
        "-f",
        "WAVE",
        "-d",
        "LEF32@16000",
        "-c",
        "1",
        aiff,
        wavPath,
      ]);
      const wav = await readFile(wavPath);
      let pcm: Buffer | undefined;
      for (let offset = 12; offset + 8 <= wav.length;) {
        const size = wav.readUInt32LE(offset + 4);
        if (wav.toString("ascii", offset, offset + 4) === "data") {
          pcm = wav.subarray(offset + 8, offset + 8 + size);
          break;
        }
        offset += 8 + size + (size % 2);
      }
      if (!pcm) throw new Error("Synthetic WAV is missing PCM audio");
      const partials: string[] = [];
      for (let offset = 0; offset < pcm.length; offset += 51_200) {
        partials.push(
          await worker.transcribe({
            utteranceId: "first-focus",
            pcm: pcm.subarray(offset, offset + 51_200).toString("base64"),
            final: false,
          }),
        );
      }
      expect(partials.some((text) => /quick brown fox/i.test(text))).toBe(true);
      const final = await worker.transcribe({ utteranceId: "first-focus", pcm: "", final: true });
      expect(final).toMatch(/quick brown fox jumps over the lazy dog/i);
      expect(final).toMatch(/local voice input in cake/i);
      // Leave a field with unprocessed speech, then send a final flush from an empty new field.
      await worker.transcribe({
        utteranceId: "abandoned",
        pcm: pcm.subarray(0, 51_200).toString("base64"),
        final: false,
      });
      expect(await worker.transcribe({ utteranceId: "new-focus", pcm: "", final: true })).toBe("");
    } finally {
      worker.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
