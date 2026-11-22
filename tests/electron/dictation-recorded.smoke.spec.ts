import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { dictationFixture } from "./fixtures/dictation";
import { openSession } from "./fixtures/workspace-navigation";

const helper = process.env.CAKE_DICTATION_TEST_HELPER;
const model = process.env.CAKE_DICTATION_TEST_MODEL;
const librispeech = process.env.CAKE_DICTATION_TEST_LIBRISPEECH;
const run = promisify(execFile);

async function fixturePCM(root: string, librispeech: string) {
  const decode = async (id: string) => {
    const [speaker, chapter] = id.split("-");
    if (!speaker || !chapter) throw new Error("Missing fixture speaker or chapter");
    const path = join(root, `${id}.wav`);
    await run("/usr/bin/afconvert", [
      "-f",
      "WAVE",
      "-d",
      "LEF32@16000",
      "-c",
      "1",
      join(librispeech, speaker, chapter, `${id}.flac`),
      path,
    ]);
    const wav = await readFile(path);
    for (let offset = 12; offset + 8 <= wav.length;) {
      const size = wav.readUInt32LE(offset + 4);
      if (wav.toString("ascii", offset, offset + 4) === "data")
        return wav.subarray(offset + 8, offset + 8 + size);
      offset += 8 + size + (size % 2);
    }
    throw new Error("Missing fixture PCM data");
  };
  // LibriSpeech test-clean, CC BY 4.0. Speaker 6930 is A; 1320 is B.
  const [a, b, aAgain] = await Promise.all([
    decode("6930-75918-0000"),
    decode("1320-122617-0022"),
    decode("6930-75918-0002"),
  ]);
  const gap = Buffer.alloc(32_000);
  return Buffer.concat([a, gap, b, gap, aAgain, Buffer.alloc(128_000)]).toString("base64");
}

for (const filtered of [false, true]) {
  test(`recorded microphone capture with the first-speaker filter ${filtered ? "on" : "off"}`, async ({}, testInfo) => {
    test.skip(
      process.platform !== "darwin" ||
        process.arch !== "arm64" ||
        !helper ||
        !model ||
        !librispeech,
      "Requires explicit native helper, Parakeet model and LibriSpeech test-clean fixtures",
    );
    if (!helper || !model || !librispeech) throw new Error("Missing native test fixtures");
    test.setTimeout(120_000);
    const fixture = await dictationFixture();
    try {
      const pcm = await fixturePCM(fixture.root, librispeech);
      const application = await fixture.launch({ helper, model });
      const timing = async () =>
        (await readFile(join(fixture.cakeHome, "logs", "desktop.log"), "utf8").catch(() => ""))
          .split("\n")
          .filter((line) =>
            /Dictation speaker filter result|"step":"(?:start-requested|speaker-prepare-finished|mic-open-requested|listening|failed)"/.test(
              line,
            ),
          )
          .join("\n");
      try {
        const page = await application.firstWindow();
        await openSession(page, "Explain this");
        // Replace only the input device. Actual audio reaches Cake's microphone worklet,
        // renderer, RPC and native models via a virtual MediaStream at microphone speed.
        const playback = await page.evaluateHandle((encoded) => {
          const context = new AudioContext({ sampleRate: 16_000 });
          const pcm = new Float32Array(Uint8Array.fromBase64(encoded).buffer);
          const audio = context.createBuffer(1, pcm.length, 16_000);
          audio.copyToChannel(pcm, 0);
          let input: MediaStreamAudioDestinationNode | undefined;
          navigator.mediaDevices.getUserMedia = async () => {
            input = context.createMediaStreamDestination();
            input.channelCount = 1;
            return input.stream;
          };
          return async () => {
            if (!input) throw new Error("Dictation did not open the virtual microphone");
            await context.resume();
            const source = context.createBufferSource();
            source.buffer = audio;
            source.connect(input);
            source.start();
          };
        }, pcm);
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: /Voice & Dictation/ }).click();
        const filter = page.getByRole("switch", { name: "Filter dictation to the first speaker" });
        await expect(filter).not.toBeChecked();
        if (filtered) await filter.click();
        await page.getByRole("switch", { name: "Dictation mode" }).click();
        await page.getByRole("button", { name: "Back to chat" }).click();
        const composer = page.getByRole("combobox", { name: "Message", exact: true });
        await composer.click();
        await expect(page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening", {
          timeout: 60_000,
        });
        await playback.evaluate((play) => play());
        await expect(composer).toHaveValue(/concord returned/i, { timeout: 15_000 });
        await expect(composer).toHaveValue(/congratulations were poured/i, { timeout: 25_000 });
        if (filtered) await expect(composer).not.toHaveValue(/delawares/i);
        else await expect(composer).toHaveValue(/delawares are children/i);
        await expect.poll(timing).toContain(`"speakerFilter":${filtered}`);
        const log = await timing();
        if (filtered) {
          const prepared = log.indexOf('"step":"speaker-prepare-finished"');
          expect(prepared).toBeGreaterThanOrEqual(0);
          expect(log.indexOf('"step":"mic-open-requested"')).toBeGreaterThan(prepared);
          expect(log).toContain('"reused":false');
          expect(log).toContain('"passedSpeech":true');
        } else expect(log).not.toContain('"step":"speaker-prepare-finished"');
      } finally {
        await application.close();
        await testInfo.attach("dictation timing", {
          body: await timing(),
          contentType: "text/plain",
        });
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}
