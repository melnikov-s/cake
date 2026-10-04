import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { emitSpeechPcm, installSpeechHttpFixture, speechHttpRequests } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
async function launch() {
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
  const server = createServer((_request, response) => {
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
              reasoning: false,
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
    `#!${process.execPath}\nconst readline = require('node:readline'); process.stdout.write(JSON.stringify({ready:true})+'\\n'); readline.createInterface({ input: process.stdin }).on('line', () => process.stdout.write(JSON.stringify({text:''})+'\\n'));\n`,
  );
  await chmod(helper, 0o755);
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
  await expect(page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible({
    timeout: 20000,
  });
  await installSpeechHttpFixture(application);
  await page.evaluate(() => {
    const tracks: MediaStreamTrack[] = [];
    const nodes: AudioBufferSourceNode[] = [];
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
      return node;
    };
    Object.assign(globalThis, { conversationAudioFixture: { tracks, nodes } });
  });
  const configure = async () => {
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /Speech output Conversation voice/ }).click();
    const key = page.getByLabel("ElevenLabs API key");
    await key.fill("fixture-private-key");
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(key).toHaveValue("");
    await page.getByRole("button", { name: "Load voices" }).click();
    await expect(
      page.getByLabel("Voice").locator("option", { hasText: "Fixture voice" }),
    ).toHaveCount(1);
    await page.getByLabel("Voice").selectOption("fixture-voice");
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await page.locator(`[data-navigation-item][data-session-id="${sessionId}"]`).click();
  };
  return {
    application,
    page,
    responses,
    configure,
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
      for (const response of responses) response.destroy();
      await application.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(directory, { recursive: true, force: true });
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

test("conversation controls enter, mute and exit with real capture and streaming playback", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByText("Listening", { exact: true })).toBeVisible();
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
    const composer = f.page.getByRole("combobox", { name: "Message", exact: true });
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
    await f.page.getByRole("button", { name: "Mute input" }).click();
    await expect(f.page.getByRole("button", { name: "Unmute input" })).toBeVisible();
    await emitSpeechPcm(f.application, true);
    f.sendText("", true);
    await f.page.getByRole("button", { name: "Exit conversation mode" }).click();
    await expect(f.page.getByRole("button", { name: "Enter conversation mode" })).toBeVisible();
    await f.page.getByRole("button", { name: "Enter conversation mode" }).click();
    await expect(f.page.getByText("Listening", { exact: true })).toBeVisible();
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
    await expect(f.page.getByText("Listening", { exact: true })).toBeVisible();
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

test("speech settings accept a masked key and voice selection through native input and select controls", async () => {
  const f = await launch();
  try {
    await f.configure();
    await f.page.getByRole("button", { name: "Open settings", exact: true }).click();
    await f.page.getByRole("button", { name: /Speech output Conversation voice/ }).click();
    const key = f.page.getByLabel("ElevenLabs API key");
    await expect(key).toHaveAttribute("type", "password");
    await expect(key).toHaveValue("");
    await expect(f.page.getByText(/Key configured/)).toBeVisible();
    await expect(f.page.getByLabel("Voice")).toHaveValue("fixture-voice");
    expect(await speechHttpRequests(f.application)).toEqual([]);
    await f.page.getByRole("button", { name: "Remove key" }).click();
    await expect(f.page.getByText(/No key configured/)).toBeVisible();
  } finally {
    await f.close();
  }
});
