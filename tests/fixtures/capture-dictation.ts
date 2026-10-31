import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

/** Replace native recognition and microphone audio, not the dictation UI or workflow. */
export async function seedCaptureDictation(userData: string) {
  const model = join(userData, "dictation", "model");
  await mkdir(model, { recursive: true });
  await writeFile(
    join(userData, "dictation", "settings.json"),
    JSON.stringify({ modelPath: model }),
  );
  const helper = join(userData, "capture-dictation");
  await writeFile(
    helper,
    `#!${process.execPath}
const readline = require('node:readline');
process.stdout.write(JSON.stringify({ready:true})+'\\n');
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.operation === 'detectSpeech') {
    const pcm = Buffer.from(request.pcm, 'base64'); let voiced = 0;
    for (let offset = 0; offset < pcm.length; offset += 4) if (Math.abs(pcm.readFloatLE(offset)) >= 0.015) voiced++;
    process.stdout.write(JSON.stringify({speech: voiced > pcm.length / 8})+'\\n');
    return;
  }
  process.stdout.write(JSON.stringify({text:'Fixture dictated annotation'})+'\\n');
});
`,
  );
  await chmod(helper, 0o755);
}

export async function installCaptureMicrophone(page: Page) {
  await page.evaluate(() => {
    const source = new AudioContext();
    const stream = source.createMediaStreamDestination().stream;
    navigator.mediaDevices.getUserMedia = async () => stream;
    const WorkletNode = AudioWorkletNode;
    globalThis.AudioWorkletNode = class extends WorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        this.port.addEventListener("message", (event) => {
          if (event.isTrusted) event.stopImmediatePropagation();
        });
        Object.assign(globalThis, { captureDictationProcessor: this });
      }
    };
  });
}
