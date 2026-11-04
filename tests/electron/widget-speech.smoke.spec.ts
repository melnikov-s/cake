import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { widgetSpeechScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");
/** Opt-in real audio: an installed Pocket TTS directory (model + settings.json), copied, never shared. */
const pocketTts = process.env.CAKE_TEST_POCKET_TTS_DIR;

async function launch(seedSpeech?: string) {
  const root = await mkdtemp(join(tmpdir(), "cake-widget-speech-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await widgetSpeechScenario.seed(paths, "light");
  if (seedSpeech) {
    await mkdir(join(paths.userData, "speech-output"), { recursive: true });
    await cp(seedSpeech, join(paths.userData, "speech-output", "pocket-tts"), { recursive: true });
  }
  const app = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
      PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  // Keep test audio off the speakers; muting does not stop the Web Audio clock.
  await app.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) contents.setAudioMuted(true);
  });
  const page = await app.firstWindow();
  await widgetSpeechScenario.prepare?.(page, "default");
  return {
    page,
    async [Symbol.asyncDispose]() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function readers(page: Page) {
  const frames = page.locator('[data-slot="artifact-disclosure"] iframe');
  await expect(frames).toHaveCount(1);
  const artifact = frames.contentFrame();
  const plugin = page.frameLocator('iframe[title="Step reader"]');
  // Click only after each widget's own script has wired its buttons.
  for (const frame of [artifact, plugin])
    await expect(frame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
  return { artifact, plugin };
}

test("artifact widgets and Session Plugins reach Cake speech and show its configuration error", async () => {
  await using cake = await launch();
  const { artifact, plugin } = await readers(cake.page);
  const configure = "Configure an ElevenLabs API key and select a voice in Speech output settings.";
  await artifact.getByRole("button", { name: "Play" }).click();
  await expect(artifact.locator("#status")).toHaveText(`error: ${configure}`);
  await plugin.getByRole("button", { name: "Read step" }).click();
  await expect(plugin.locator("output")).toHaveText(`error: ${configure}`);
});

test("reads aloud with pause, resume, stop and one speaker at a time", async () => {
  test.skip(!pocketTts, "Set CAKE_TEST_POCKET_TTS_DIR to an installed Pocket TTS directory");
  test.setTimeout(120_000);
  await using cake = await launch(pocketTts);
  const { artifact, plugin } = await readers(cake.page);
  const status = artifact.locator("#status");

  await artifact.getByRole("button", { name: "Play" }).click();
  await expect(status).toHaveText(/^playing 1\/4$/, { timeout: 60_000 });
  await expect(artifact.locator("mark")).toHaveText("Cake can read widgets aloud.");
  await expect(status).toHaveText(/^playing 2\/4$/, { timeout: 30_000 });

  await artifact.getByRole("button", { name: "Pause" }).click();
  await expect(status).toHaveText(/^paused 2\/4$/);
  // A suspended audio clock never finishes the sentence, so progress must not advance.
  await cake.page.waitForTimeout(6_000);
  await expect(status).toHaveText(/^paused 2\/4$/);
  await expect(artifact.locator("mark")).toHaveText(
    "Press Play to hear this article in your configured voice.",
  );

  await artifact.getByRole("button", { name: "Resume" }).click();
  await expect(status).toHaveText(/^playing [34]\/4$/, { timeout: 30_000 });
  await expect(status).toHaveText("ended 4/4", { timeout: 60_000 });

  await artifact.getByRole("button", { name: "Play" }).click();
  await expect(status).toHaveText(/^playing 1\/4$/, { timeout: 60_000 });
  await artifact.getByRole("button", { name: "Stop" }).click();
  await expect(status).toHaveText("idle");

  await artifact.getByRole("button", { name: "Play" }).click();
  await expect(status).toHaveText(/^(loading|playing) 1\/4$/, { timeout: 60_000 });
  await plugin.getByRole("button", { name: "Read step" }).click();
  await expect(status).toHaveText("idle");
  await expect(plugin.locator("output")).toHaveText("plugin playing", { timeout: 60_000 });
  await expect(plugin.locator("output")).toHaveText("plugin ended", { timeout: 60_000 });
});
