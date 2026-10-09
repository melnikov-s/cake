import { chmod, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pocketManifest from "../../src/services/speech/pocket-tts-manifest.json" with { type: "json" };
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import {
  emitInvalidSpeechPcm,
  emitSpeechPcm,
  installSpeechHttpFixture,
  speechHttpRequests,
} from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
async function launch({
  reasoning = false,
  recognizeSpeech = false,
  recognitionTexts = [],
  secondSession = false,
  foreground = false,
  localInstalled = false,
  postProcessedText,
}: {
  reasoning?: boolean;
  recognizeSpeech?: boolean;
  recognitionTexts?: string[];
  secondSession?: boolean;
  foreground?: boolean;
  localInstalled?: boolean;
  postProcessedText?: string;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cake-conversation-"));
  const userData = join(directory, "user-data"),
    project = join(directory, "project"),
    cakeHome = join(directory, "cake-home");
  const sessionId = "conversation-session",
    timestamp = new Date(0).toISOString();
  const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
  const model = join(userData, "dictation", "model");
  await Promise.all([
    mkdir(sessions, { recursive: true }),
    mkdir(model, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  const responses: ServerResponse[] = [];
  const utilityRequests: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    if (
      postProcessedText !== undefined &&
      body.includes("Lightly clean a speech-to-text transcript")
    ) {
      utilityRequests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "utility", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content: JSON.stringify({ text: postProcessedText }) }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    responses.push(response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          name: "Fixture",
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 4096,
              maxTokens: 1024,
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(userData, "dictation", "settings.json"),
    JSON.stringify({ modelPath: model }),
  );
  const helper = join(directory, "dictation");
  await writeFile(
    helper,
    `#!${process.execPath}
const readline = require('node:readline');
const texts = ${JSON.stringify(recognitionTexts)};
const utterances = new Map();
process.stdout.write(JSON.stringify({ready:true})+'\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.operation === 'detectSpeech') {
    const pcm = Buffer.from(request.pcm, 'base64'); let voiced = 0;
    for (let offset = 0; offset < pcm.length; offset += 4) if (Math.abs(pcm.readFloatLE(offset)) >= 0.015) voiced++;
    process.stdout.write(JSON.stringify({ speech: voiced > pcm.length / 8 }) + '\\n');
    return;
  }
  if (!utterances.has(request.utteranceId)) utterances.set(request.utteranceId, utterances.size);
  const index = utterances.get(request.utteranceId);
  const text = texts[index] ?? (${recognizeSpeech} && request.final ? 'Spoken request ' + (index + 1) : '');
  process.stdout.write(JSON.stringify({text})+'\\n');
});
`,
  );
  await chmod(helper, 0o755);
  // Fake only the external native inference/model assets, keeping real installation
  // inspection, provider selection, RPC, Store, Chat, capture and playback.
  const speechHelper = join(directory, "cake-speech");
  const localRequests = join(directory, "pocket-requests.jsonl");
  await writeFile(localRequests, "");
  await writeFile(
    speechHelper,
    `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(localRequests)}, JSON.stringify(request) + '\\n');
  process.stdout.write(JSON.stringify({ pcm: Buffer.alloc(4800).toString('base64') }) + '\\n');
  process.stdout.write(JSON.stringify({ done: true }) + '\\n');
});
`,
  );
  await chmod(speechHelper, 0o755);
  await writeFile(join(directory, "pocket-tts-manifest.json"), JSON.stringify(pocketManifest));
  if (localInstalled) {
    const localModel = join(userData, "speech-output", "pocket-tts", "model");
    for (const file of pocketManifest.files) {
      const path = join(localModel, pocketManifest.modelDirectory, file.path);
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, "w");
      await handle.truncate(file.bytes);
      await handle.close();
    }
    await writeFile(
      join(localModel, "installation.sha256"),
      createHash("sha256").update(JSON.stringify(pocketManifest)).digest("hex"),
    );
  }
  // Silence keeps the real worklet/capture path active without artificially barging into output.
  const wav = Buffer.alloc(44 + 16000 * 2 * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  const wavPath = join(directory, "silence.wav");
  await writeFile(wavPath, wav);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      selectedSessionId: sessionId,
      activeConversation: { kind: "project-session", workspacePath: project, sessionId },
      recentProjectPaths: [project],
      draft: "",
      theme: "dark",
      draftsBySession: {},
    }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: project, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp }],
      trustedProjectPaths: [],
      ...(postProcessedText !== undefined
        ? { utilityModel: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" } }
        : {}),
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "model_change",
        id: "model",
        parentId: null,
        timestamp,
        provider: "fixture",
        modelId: "fixture",
      },
      {
        type: "message",
        id: "history",
        parentId: "model",
        timestamp,
        message: { role: "user", content: "Fixture history", timestamp: 0 },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  if (secondSession)
    await writeFile(
      join(sessions, "1970-01-01T00-00-00-000Z_second-session.jsonl"),
      [
        { type: "session", version: 3, id: "second-session", timestamp, cwd: project },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: "fixture",
          modelId: "fixture",
        },
        {
          type: "message",
          id: "history",
          parentId: "model",
          timestamp,
          message: { role: "user", content: "Second session", timestamp: 0 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
  const application = await electron.launch({
    args: [
      repositoryRoot,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${wavPath}`,
    ],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_SMOKE_DICTATION_HELPER: helper,
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });
  const page = await application.firstWindow();
  await expect(page.locator("strong").filter({ hasText: "Fixture history" })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible({
    timeout: 20000,
  });
  await expect
    .poll(() =>
      application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    )
    .toBe(true);
  await installSpeechHttpFixture(application);
  await page.evaluate(() => {
    const tracks: MediaStreamTrack[] = [];
    const contexts: AudioContext[] = [];
    const resume = AudioContext.prototype.resume;
    AudioContext.prototype.resume = function () {
      if (!contexts.includes(this)) contexts.push(this);
      return resume.call(this);
    };
    const nodes: AudioBufferSourceNode[] = [];
    const endedNodes: AudioBufferSourceNode[] = [];
    const processors: AudioWorkletNode[] = [];
    const WorkletNode = AudioWorkletNode;
    globalThis.AudioWorkletNode = class extends WorkletNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        processors.push(this);
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      tracks.push(...stream.getTracks());
      return stream;
    };
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = create.call(this);
      nodes.push(node);
      node.addEventListener("ended", () => endedNodes.push(node), { once: true });
      return node;
    };
    Object.assign(globalThis, {
      conversationAudioFixture: { tracks, contexts, nodes, endedNodes, processors },
    });
  });
  const configure = async () => {
    await expect(async () => {
      const section = page.getByRole("button", { name: /Voice & Dictation/ });
      if (!(await section.isVisible()))
        await page.getByRole("button", { name: "Open settings", exact: true }).click();
      await section.click({ timeout: 1000 });
      await expect(page.getByLabel("ElevenLabs API key")).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    const key = page.getByLabel("ElevenLabs API key");
    await key.fill("fixture-private-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(key).toHaveValue("");
    await page.getByRole("button", { name: "Refresh voices" }).click();
    await expect(
      page.getByLabel("Voice", { exact: true }).locator("option", { hasText: "Fixture voice" }),
    ).toHaveCount(1);
    await page.getByLabel("Voice", { exact: true }).selectOption("fixture-voice");
    await expect(page.getByLabel("Voice", { exact: true })).toHaveValue("fixture-voice");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
  };
  return {
    application,
    page,
    responses,
    utilityRequests,
    configure,
    userData,
    localRequests,
    async frames(chunks: [number, number][]) {
      await page.evaluate((chunks) => {
        const fixture = Reflect.get(globalThis, "conversationAudioFixture") as {
          processors: AudioWorkletNode[];
        };
        const processor = fixture.processors.at(-1)!;
        for (const [value, count] of chunks)
          for (let i = 0; i < count; i++)
            processor.port.dispatchEvent(
              new MessageEvent("message", { data: new Float32Array(1600).fill(value) }),
            );
      }, chunks);
    },
    sendText(text: string, finish = false) {
      const response = responses.at(-1);
      if (!response) throw new Error("No Pi request opened");
      response.write(
        `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { content: text }, finish_reason: finish ? "stop" : null }] })}\n\n`,
      );
      if (finish) {
        response.write("data: [DONE]\n\n");
        response.end();
      }
    },
    async close() {
      try {
        if (!foreground)
          await expect
            .poll(() =>
              application.evaluate(({ BrowserWindow }) =>
                BrowserWindow.getAllWindows().every(
                  (window) => !window.isVisible() && !window.isFocused(),
                ),
              ),
            )
            .toBe(true);
      } finally {
        for (const response of responses) response.destroy();
        await application.close();
        await new Promise<void>((done) => server.close(() => done()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}
test.beforeEach(() => {
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "Native Parakeet requires Apple Silicon/macOS 14+",
  );
  test.setTimeout(60000);
});

test("utility post-processing cleans voice input through real RPC and Pi completion before sending", async () => {
  const f = await launch({
    recognizeSpeech: true,
    recognitionTexts: ["Um, we need to. Do that."],
    postProcessedText: "We need to do that.",
  });
  try {
    await f.configure();
    const composer = f.page.getByRole("combobox", { name: "Message" });
    await composer.click();
    await composer.pressSequentially("Typed prefix:");
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await composer.click();
    await expect(composer).toBeFocused();
    await f.frames([[0.1, 10]]);
    await expect(composer).toHaveValue("Typed prefix: Um, we need to. Do that.");
    const raw = f.page.locator('[data-slot="provisional-text"]');
    await expect(raw).toHaveText("Um, we need to. Do that.");
    await expect(raw).toHaveClass(/text-muted-foreground/);
    const colors = await raw.evaluate((element) => ({
      raw: getComputedStyle(element).color,
      typed: getComputedStyle(element.parentElement!).color,
    }));
    expect(colors.raw).not.toBe(colors.typed);
    await expect(f.page.locator('[data-slot="textarea-provisional-overlay"]')).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    await expect(composer).toBeFocused();
    await f.frames([[0, 40]]);
    await expect.poll(() => f.utilityRequests.length).toBe(1);
    await expect(
      f.page.getByRole("article").filter({ hasText: "Typed prefix: We need to do that." }),
    ).toBeVisible();
    await expect(composer).toHaveValue("");
    await expect(raw).toHaveCount(0);
    expect(f.utilityRequests[0]).toContain("Um, we need to. Do that.");
    expect(f.utilityRequests[0]).not.toContain("Typed prefix:");
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Still editable");
    await expect(composer).toHaveValue("Still editable");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("provisional speech wraps and scrolls with the native composer without taking focus", async () => {
  const rawText = "We need to. Do that. ".repeat(140);
  const f = await launch({ recognizeSpeech: true, recognitionTexts: [rawText] });
  try {
    await f.configure();
    const composer = f.page.getByRole("combobox", { name: "Message" });
    await composer.fill("Typed prefix:\n");
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await composer.click();
    await f.frames([[0.1, 10]]);
    await expect(composer).toHaveValue("Typed prefix:\n" + rawText.trim());
    await expect(f.page.locator('[data-slot="provisional-text"]')).toBeVisible();
    const layout = await composer.evaluate((element) => {
      const overlay = element.parentElement!.querySelector(
        '[data-slot="textarea-provisional-overlay"]',
      )!;
      const mirror = overlay.firstElementChild!;
      const native = getComputedStyle(element),
        mirrored = getComputedStyle(mirror);
      const frame = overlay.getBoundingClientRect(),
        input = element.getBoundingClientRect();
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      return {
        scrollable: element.scrollHeight > element.clientHeight,
        width: frame.width,
        inputWidth: element.clientWidth,
        top: frame.top,
        inputTop: input.top + element.clientTop,
        font: [native.fontFamily, native.fontSize, native.lineHeight],
        mirrorFont: [mirrored.fontFamily, mirrored.fontSize, mirrored.lineHeight],
        padding: [native.paddingLeft, native.paddingRight, native.textIndent],
        mirrorPadding: [mirrored.paddingLeft, mirrored.paddingRight, mirrored.textIndent],
      };
    });
    expect(layout.scrollable).toBe(true);
    expect(layout.width).toBe(layout.inputWidth);
    expect(layout.top).toBe(layout.inputTop);
    expect(layout.font).toEqual(layout.mirrorFont);
    expect(layout.padding).toEqual(layout.mirrorPadding);
    await expect
      .poll(() =>
        composer.evaluate((element) => {
          const mirror = element.parentElement!.querySelector(
            '[data-slot="textarea-provisional-overlay"]',
          )!.firstElementChild!;
          return new DOMMatrixReadOnly(getComputedStyle(mirror).transform).m42 + element.scrollTop;
        }),
      )
      .toBe(0);
    await expect(composer).toBeFocused();
    await composer.pressSequentially(" edited");
    await expect(f.page.locator('[data-slot="provisional-text"]')).toHaveCount(0);
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("conversation controls enter, mute and exit with real capture and streaming playback", async () => {
  const f = await launch();
  try {
    await f.configure();
    // Hold only the external microphone boundary so loading geometry is deterministic.
    await f.page.evaluate(() => {
      const open = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        await ready;
        return open(constraints);
      };
      Object.assign(globalThis, { releaseConversationMicrophone: release });
    });
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.focus();
    await composer.pressSequentially("Typed while loading.");
    const layout = () =>
      composer.evaluate((element) => {
        const field = element.getBoundingClientRect();
        const frame = element.closest("form")!.getBoundingClientRect();
        return { inputHeight: field.height, frameHeight: frame.height };
      });
    const restingLayout = await layout();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    const preparing = f.page.getByRole("button", { name: "Preparing conversation mode" });
    await expect(preparing).toHaveAttribute("aria-busy", "true");
    await expect(preparing).toBeDisabled();
    await expect(preparing.locator('[role="status"]')).toBeVisible();
    const preparingSize = await preparing.boundingBox();
    expect(preparingSize!.width).toBe(30);
    expect(preparingSize!.height).toBe(30);
    expect(await layout()).toEqual(restingLayout);
    await composer.focus();
    await composer.press("End");
    await composer.pressSequentially(" Still typing.");
    await expect(composer).toHaveValue("Typed while loading. Still typing.");
    await expect(composer).toBeFocused();
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await f.page.evaluate(() => {
      const release = Reflect.get(globalThis, "releaseConversationMicrophone") as () => void;
      release();
    });
    const earControl = f.page.getByRole("button", { name: "Mute input" });
    await expect(earControl).toHaveAttribute("aria-pressed", "true");
    const activeSize = await earControl.boundingBox();
    expect(activeSize!.width).toBe(preparingSize!.width);
    expect(activeSize!.height).toBe(preparingSize!.height);
    expect(await layout()).toEqual(restingLayout);
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as { tracks: MediaStreamTrack[] }
            ).tracks.filter((track) => track.readyState === "live").length,
        ),
      )
      .toBe(1);
    await composer.fill("Speak a response");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.responses.length).toBe(1);
    f.sendText("A streaming spoken sentence. ");
    await expect(f.page.getByText("A streaming spoken sentence.", { exact: true })).toBeVisible();
    await expect
      .poll(() => speechHttpRequests(f.application))
      .toEqual(["A streaming spoken sentence."]);
    await emitSpeechPcm(f.application);
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as {
                nodes: AudioBufferSourceNode[];
              }
            ).nodes.length,
        ),
      )
      .toBe(1);
    // Output is already scheduled while both the provider and Pi responses remain open.
    const ear = f.page.getByRole("button", { name: "Mute input", exact: true });
    await expect(ear.locator("svg")).toBeVisible();
    await expect(ear).toHaveText("");
    await ear.hover();
    await expect(f.page.getByRole("tooltip")).toHaveText("Listening — mute input");
    await ear.click();
    const mutedEar = f.page.getByRole("button", { name: "Unmute input", exact: true });
    await expect(mutedEar).toHaveAttribute("aria-pressed", "false");
    await expect(mutedEar.locator("svg")).toBeVisible();
    await f.page.mouse.move(1, 1);
    await mutedEar.hover();
    await expect(f.page.getByRole("tooltip")).toHaveText("Input muted — unmute input");
    await mutedEar.click();
    await expect(ear).toHaveAttribute("aria-pressed", "true");
    await emitSpeechPcm(f.application, true);
    f.sendText("", true);
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  } finally {
    await f.close();
  }
});

test("a fast reply reuses the ready output context and produces copyable voice diagnostics", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await f.page
      .getByRole("combobox", { name: "Message", exact: true })
      .fill("Speak a fast response");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.responses.length).toBe(1);
    f.sendText("A fast spoken answer.", true);
    await expect.poll(() => speechHttpRequests(f.application)).toEqual(["A fast spoken answer."]);
    await emitSpeechPcm(f.application, true);
    await expect
      .poll(() =>
        f.page.evaluate(() => {
          const fixture = Reflect.get(globalThis, "conversationAudioFixture") as {
            nodes: AudioBufferSourceNode[];
          };
          return fixture.nodes.length;
        }),
      )
      .toBe(1);
    expect(
      await f.page.evaluate(() => {
        const fixture = Reflect.get(globalThis, "conversationAudioFixture") as {
          contexts: AudioContext[];
        };
        return fixture.contexts.filter((context) => context.sampleRate === 24000).length;
      }),
    ).toBe(1);
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await f.page.getByRole("button", { name: "Copy voice diagnostics", exact: true }).click();
    await expect(
      f.page.getByRole("button", { name: "Voice diagnostics copied", exact: true }),
    ).toBeVisible();
    const report = await f.application.evaluate(({ clipboard }) => clipboard.readText());
    expect(report).toContain('"playback-ready"');
    expect(report).toContain('"playback-chunk"');
    expect(report).toContain('"first-audio"');
    expect(report).not.toContain("A fast spoken answer");
    expect(report).not.toContain("fixture-private-key");
    expect(report).not.toContain('"pcm"');
  } finally {
    await f.close();
  }
});

test("suspended output reports an error with copyable diagnostics instead of silent voice mode", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.evaluate(() => {
      const resume = AudioContext.prototype.resume;
      AudioContext.prototype.resume = function () {
        // Electron may start a new context automatically. Hold the real output
        // context suspended to model a device that cannot resume.
        return this.sampleRate === 24000 ? this.suspend() : resume.call(this);
      };
    });
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    const toast = f.page.getByRole("alert");
    await expect(toast).toContainText("Speech audio is suspended");
    await toast.getByRole("button", { name: "Technical details" }).click();
    await toast.getByRole("button", { name: "Copy full error details" }).click();
    await expect(toast.getByRole("button", { name: "Copied full error details" })).toBeVisible();
    const details = await f.application.evaluate(({ clipboard }) => clipboard.readText());
    expect(details).toContain('"playback-start"');
    expect(details).toContain('"state": "suspended"');
    expect(await speechHttpRequests(f.application)).toEqual([]);
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.focus();
    await composer.pressSequentially("Text still works");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Text still works");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("@foreground conversation capture stops on native window blur", async () => {
  test.skip(
    process.env.CAKE_ELECTRON_FOREGROUND_TESTS !== "1",
    "Native OS focus changes require explicit opt-in; ordinary microphone tests stay hidden.",
  );
  const f = await launch({ foreground: true });
  try {
    await f.configure();
    await f.application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]!;
      window.show();
      window.focus();
    });
    await expect
      .poll(() =>
        f.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isFocused(),
        ),
      )
      .toBe(true);
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await expect
      .poll(() =>
        f.page.evaluate(() =>
          (
            Reflect.get(globalThis, "conversationAudioFixture") as { tracks: MediaStreamTrack[] }
          ).tracks.some((track) => track.readyState === "live"),
        ),
      )
      .toBe(true);
    await f.application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.blur());
    await expect
      .poll(() =>
        f.application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isFocused(),
        ),
      )
      .toBe(false);
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await expect
      .poll(() =>
        f.page.evaluate(() =>
          (
            Reflect.get(globalThis, "conversationAudioFixture") as { tracks: MediaStreamTrack[] }
          ).tracks.every((track) => track.readyState === "ended"),
        ),
      )
      .toBe(true);
  } finally {
    await f.close();
  }
});

test("live words appear in the focused composer, countdown cancellation retains them, and resumed speech sends the complete draft", async () => {
  const f = await launch({ recognitionTexts: ["First thought", "and more"] });
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    const input = f.page.getByRole("combobox", { name: "Message", exact: true });
    await input.click();
    await input.pressSequentially("Typed prefix ");
    await expect(input).toBeFocused();
    await f.frames([[0.1, 8]]);
    await expect(input).toHaveValue("Typed prefix First thought");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await f.frames([[0, 5]]);
    await expect(f.page.getByRole("button", { name: "Cancel automatic send" })).toHaveCount(0);
    await expect(f.page.getByRole("button", { name: "Mute input" }).locator("circle")).toHaveCount(
      0,
    );
    await f.frames([[0, 5]]);
    await f.page.getByRole("button", { name: "Cancel automatic send" }).click();
    await f.frames([[0, 30]]);
    await expect(input).toHaveValue("Typed prefix First thought");
    expect(f.responses).toHaveLength(0);
    await f.frames([[0.1, 8]]);
    await expect(input).toHaveValue("Typed prefix First thought and more");
    await f.frames([[0, 30]]);
    await expect.poll(() => f.responses.length).toBe(1);
    await expect(input).toHaveValue("");
    await expect(
      f.page.getByRole("article").filter({ hasText: "Typed prefix First thought and more" }),
    ).toBeVisible();
  } finally {
    await f.close();
  }
});

test("dictation stays enabled through voice mode and immediately works after switching sessions", async () => {
  const f = await launch({
    secondSession: true,
    recognitionTexts: Array(10).fill("Dictated words"),
  });
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    const toggle = f.page.getByRole("switch", { name: "Dictation mode" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await f.page.locator('[data-navigation-item][data-session-id="conversation-session"]').click();
    const input = f.page.getByRole("combobox", { name: "Message", exact: true });
    await input.click();
    await expect(f.page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await f.frames([[0.1, 8]]);
    await expect(input).toHaveValue("Dictated words");
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await input.click();
    await expect(f.page.locator('[data-slot="dictation-indicator"]')).toHaveCount(0);
    await f.page.locator('[data-navigation-item][data-session-id="second-session"]').click();
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await input.click();
    await expect(input).toBeFocused();
    await expect(f.page.locator('[data-slot="dictation-indicator"]')).toHaveText("Listening");
    await f.frames([[0.1, 8]]);
    await expect(input).toHaveValue("Dictated words");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  } finally {
    await f.close();
  }
});

test("local speech provider uses native selection, persists, and speaks without an ElevenLabs key", async () => {
  const f = await launch({ localInstalled: true });
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await f.page.getByRole("button", { name: "Remove key" }).click();
    await expect(f.page.getByText(/No key configured/)).toBeVisible();
    const provider = f.page.getByLabel("Speech provider");
    await provider.focus();
    await provider.selectOption("pocket-tts");
    await expect(provider).toHaveValue("pocket-tts");
    const slider = f.page.getByRole("slider", { name: "Speaking speed" });
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveValue("2");
    await expect(f.page.getByText("2.00×", { exact: true })).toBeVisible();
    await expect(slider).toHaveAttribute("max", "2");
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(join(f.userData, "speech-output", "pocket-tts", "settings.json"), "utf8"),
        );
        return saved.speed;
      })
      .toBe(2);
    await provider.selectOption("elevenlabs");
    await expect(slider).toHaveValue("1");
    await expect(slider).toHaveAttribute("max", "1.2");
    await expect(
      f.page.getByText("ElevenLabs speed is saved separately; its limit is 1.2×."),
    ).toBeVisible();
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveValue("1.2");
    await expect
      .poll(
        async () =>
          JSON.parse(await readFile(join(f.userData, "speech-output", "settings.json"), "utf8"))
            .speed,
      )
      .toBe(1.2);
    await provider.selectOption("pocket-tts");
    await expect(slider).toHaveValue("2");
    await expect(
      f.page.getByText("Pocket TTS is installed and ready for voice mode."),
    ).toBeVisible();
    await expect
      .poll(async () =>
        JSON.parse(
          await readFile(join(f.userData, "speech-output", "pocket-tts", "settings.json"), "utf8"),
        ),
      )
      .toEqual({ selected: true, speed: 2 });
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Speak locally");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Speak locally");
    const send = f.page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeEnabled();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toBeVisible();
    await send.click();
    await expect.poll(() => f.responses.length).toBe(1);
    await expect(composer).toHaveValue("");
    // Finish in the same provider event: no 50ms streaming projection is needed
    // for live completed text to speak. Commas and contractions stay together.
    const reply = "This isn’t broken, and it’s spoken as one sentence.";
    f.sendText(reply, true);
    await expect(f.page.getByText(reply, { exact: true })).toBeVisible();
    await expect
      .poll(async () => (await readFile(f.localRequests, "utf8")).trim())
      .toBe(JSON.stringify({ text: reply, voice: "alba", speed: 2 }));
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as {
                nodes: AudioBufferSourceNode[];
              }
            ).nodes.length,
        ),
      )
      .toBeGreaterThan(0);
    expect(await speechHttpRequests(f.application)).toEqual([]);
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
  } finally {
    await f.close();
  }
});

test("uninstalled local output offers one download button and never falls back to configured cloud speech", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await f.page.getByLabel("Speech provider").selectOption("pocket-tts");
    await expect(
      f.page.getByRole("button", { name: "Download Pocket TTS · 370 MB" }),
    ).toBeEnabled();
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(
      f.page.getByText(
        "Download Pocket TTS in Settings → Voice & Dictation before entering voice mode.",
      ),
    ).toBeVisible();
    expect(await speechHttpRequests(f.application)).toEqual([]);
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Text still works");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Text still works");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  } finally {
    await f.close();
  }
});

test("settings slider saves a faster speed alongside the persisted voice list", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    const slider = f.page.getByRole("slider", { name: "Speaking speed" });
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveValue("1.2");
    await expect(f.page.getByText("1.20×", { exact: true })).toBeVisible();
    await expect(slider).toBeEnabled();
    // Service tests cover reacquisition from this file without provider requests.
    // Electron verifies native keyboard input and the real atomic persistence boundary.
    await expect
      .poll(async () => {
        const saved = JSON.parse(
          await readFile(join(f.userData, "speech-output", "settings.json"), "utf8"),
        );
        return { speed: saved.speed, voices: saved.voices };
      })
      .toEqual({ speed: 1.2, voices: [{ id: "fixture-voice", name: "Fixture voice" }] });
    await expect(
      f.page.getByLabel("Voice", { exact: true }).locator("option", { hasText: "Fixture voice" }),
    ).toHaveCount(1);
  } finally {
    await f.close();
  }
});

test("quieter follow-up speech with syllable gaps is accepted after a spoken reply without restarting capture", async () => {
  const f = await launch({ recognizeSpeech: true });
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await f.frames([
      [0.1, 8],
      [0, 30],
    ]);
    await expect.poll(() => f.responses.length).toBe(1);
    f.sendText("First answer. ");
    await expect.poll(() => speechHttpRequests(f.application)).toEqual(["First answer."]);
    await emitSpeechPcm(f.application, true);
    f.sendText("", true);
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as {
                endedNodes: AudioBufferSourceNode[];
              }
            ).endedNodes.length,
        ),
      )
      .toBe(1);
    await f.frames([
      [0.02, 2],
      [0, 1],
      [0.02, 2],
      [0, 1],
      [0.02, 2],
      [0, 30],
    ]);
    await expect(f.page.getByRole("article").filter({ hasText: "Spoken request 2" })).toBeVisible();
    await expect.poll(() => f.responses.length).toBe(2);
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as {
                tracks: MediaStreamTrack[];
                processors: AudioWorkletNode[];
              }
            ).processors.length,
        ),
      )
      .toBe(1);
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
  } finally {
    await f.close();
  }
});

for (const { text, frames } of [
  { text: "Wait.", frames: 2 },
  { text: "Actually change that approach", frames: 8 },
]) {
  test(`background acknowledgment leaves speech running, but ${text} interrupts through recognition`, async () => {
    const f = await launch({ recognitionTexts: ["all right", text] });
    try {
      await f.configure();
      await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
      await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await f.page.getByRole("combobox", { name: "Message", exact: true }).fill("First request");
      await f.page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(() => f.responses.length).toBe(1);
      f.sendText("First answer. ");
      await expect.poll(() => speechHttpRequests(f.application)).toEqual(["First answer."]);
      await emitSpeechPcm(f.application);
      await f.frames([
        [0.1, 8],
        [0, 30],
      ]);
      // The first provider stream is still open: a rejected snippet must not cancel it.
      f.sendText("Still speaking. ");
      await emitSpeechPcm(f.application, true);
      await expect
        .poll(() => speechHttpRequests(f.application))
        .toEqual(["First answer.", "Still speaking."]);
      await expect(f.page.getByRole("list", { name: "Queued prompts" })).toHaveCount(0);
      await emitSpeechPcm(f.application);
      await expect
        .poll(() =>
          f.page.evaluate(
            () =>
              (
                Reflect.get(globalThis, "conversationAudioFixture") as {
                  nodes: AudioBufferSourceNode[];
                }
              ).nodes.length,
          ),
        )
        .toBe(3);
      await f.frames([
        [0.1, frames],
        [0, 30],
      ]);
      await expect
        .poll(() =>
          f.page.evaluate(
            () =>
              (
                Reflect.get(globalThis, "conversationAudioFixture") as {
                  nodes: AudioBufferSourceNode[];
                }
              ).nodes.at(-1)?.context.state,
          ),
        )
        .toBe("closed");
      await expect(
        f.page.getByRole("button", { name: `View queued message: ${text}`, exact: true }),
      ).toBeVisible();
      // Confirmed speech is ordinary queued input, not an abort of the active agent.
      expect(f.responses).toHaveLength(1);
      await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
    } finally {
      await f.close();
    }
  });
}

test("barge-in keeps the interrupted reply silent and speaks the next turn from its beginning", async () => {
  const f = await launch({ reasoning: true, recognitionTexts: ["Wait."] });
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.fill("First request");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.responses.length).toBe(1);
    f.sendText("First answer. ");
    await expect.poll(() => speechHttpRequests(f.application)).toEqual(["First answer."]);
    await emitSpeechPcm(f.application);
    // Drive barge-in through the real microphone port/VAD, not a Store method.
    await f.frames([[0.1, 8]]);
    await expect
      .poll(() =>
        f.page.evaluate(
          () =>
            (
              Reflect.get(globalThis, "conversationAudioFixture") as {
                nodes: AudioBufferSourceNode[];
              }
            ).nodes[0]?.context.state,
        ),
      )
      .toBe("closed");
    await f.page.getByRole("button", { name: "Mute input" }).click();
    // A configuration operation refreshes the authoritative snapshot while Pi
    // still generates the old reply, replacing its live user ID with an entry ID.
    await f.page.getByRole("button", { name: "Model configuration", exact: true }).click();
    await f.page.getByRole("button", { name: "Low", exact: true }).click();
    await expect(
      f.page.getByRole("button", { name: "Model configuration", exact: true }),
    ).toContainText("Low");
    await composer.fill("Next request");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    f.sendText("Interrupted remainder. ", true);
    await expect.poll(() => f.responses.length).toBe(2);
    f.sendText("Next answer starts here. ");
    await expect
      .poll(() => speechHttpRequests(f.application))
      .toEqual(["First answer.", "Next answer starts here."]);
    await expect(f.page.getByText("Next answer starts here.", { exact: true })).toBeVisible();
    await emitSpeechPcm(f.application, true);
    f.sendText("", true);
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
  } finally {
    await f.close();
  }
});

test("invalid provider PCM reaches a dismissible toast through native RPC and leaves the composer usable", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.fill("Speak a response");
    await f.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => f.responses.length).toBe(1);
    f.sendText("A visible answer. ");
    await expect.poll(() => speechHttpRequests(f.application)).toEqual(["A visible answer."]);
    await emitInvalidSpeechPcm(f.application);
    const toast = f.page.getByRole("alert").filter({ hasText: "Conversation mode unavailable" });
    await expect(toast).toContainText(
      "ElevenLabs returned invalid PCM audio. No automatic retry was made.",
    );
    await expect(
      f.page
        .locator(".workbench-composer")
        .getByText("ElevenLabs returned invalid PCM audio. No automatic retry was made.", {
          exact: true,
        }),
    ).toHaveCount(0);
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await expect
      .poll(() =>
        f.page.evaluate(() =>
          (
            Reflect.get(globalThis, "conversationAudioFixture") as { tracks: MediaStreamTrack[] }
          ).tracks.every((track) => track.readyState === "ended"),
        ),
      )
      .toBe(true);
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toHaveCount(0);
    f.sendText("", true);
    await composer.click();
    await composer.pressSequentially("Continue in text");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Continue in text");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await expect(f.page.getByText("A visible answer.", { exact: true })).toBeVisible();
    expect(await speechHttpRequests(f.application)).toEqual(["A visible answer."]);
  } finally {
    await f.close();
  }
});

test("typed composer retains focus, actual input value and enabled submission across voice-mode transitions", async () => {
  const f = await launch();
  try {
    await f.configure();
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Typed draft survives");
    await expect(composer).toHaveValue("Typed draft survives");
    await expect(composer).toBeFocused();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Mute input" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await composer.click();
    await composer.pressSequentially(" and typing works");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Typed draft survives and typing works");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
    await composer.click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Typed draft survives and typing works");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(await speechHttpRequests(f.application)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("speech error toast opens settings and speech can be hidden and re-enabled without affecting text input", async () => {
  const f = await launch();
  try {
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    const toast = f.page.getByRole("alert").filter({ hasText: "Conversation mode unavailable" });
    await expect(toast).toBeVisible();
    await toast.getByText("Configure an ElevenLabs key and voice", { exact: false }).click();
    await expect(f.page.getByRole("region", { name: "Speech output", exact: true })).toBeVisible();
    await expect(toast).toHaveCount(0);
    const enabled = f.page.getByRole("switch", { name: "Enable speech", exact: true });
    await enabled.click();
    await expect(enabled).not.toBeChecked();
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await f.page.locator('[data-navigation-item][data-session-id="conversation-session"]').click();
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toHaveCount(0);
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
    await composer.click();
    await composer.pressSequentially("Text chat still works");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Text chat still works");
    await expect(f.page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await enabled.click();
    await expect(enabled).toBeChecked();
    await f.page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await f.page.locator('[data-navigation-item][data-session-id="conversation-session"]').click();
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await expect(composer).toHaveValue("Text chat still works");
    expect(await speechHttpRequests(f.application)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("speech settings accept a masked key and voice selection through native input and select controls", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    const key = f.page.getByLabel("ElevenLabs API key");
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("placeholder", "••••••••••••••••");
    await expect(f.page.getByRole("button", { name: "Save key", exact: true })).toBeDisabled();
    await expect(f.page.getByText(/Key configured/)).toBeVisible();
    await expect(f.page.getByLabel("Voice", { exact: true })).toHaveValue("fixture-voice");
    await f.page.reload();
    // Settings itself is restored by window-state persistence.
    await f.page.getByRole("button", { name: /Voice & Dictation/ }).click();
    await expect(key).toHaveAttribute("placeholder", "••••••••••••••••");
    await key.focus();
    await key.pressSequentially("replacement-fixture-key");
    await expect(key).toBeFocused();
    await expect(key).toHaveValue("replacement-fixture-key");
    await expect(f.page.getByRole("button", { name: "Save key", exact: true })).toBeEnabled();
    await f.page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(key).toHaveValue("");
    await expect(key).toHaveAttribute("placeholder", "••••••••••••••••");
    expect(await speechHttpRequests(f.application)).toEqual([]);
    await f.page.getByRole("button", { name: "Remove key" }).click();
    await expect(f.page.getByText(/No key configured/)).toBeVisible();
    await expect(key).not.toHaveAttribute("placeholder", "••••••••••••••••");
  } finally {
    await f.close();
  }
});
