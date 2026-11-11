import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

function reply(response: ServerResponse, content: string | { name: string; arguments: object }) {
  const tool = typeof content !== "string";
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "capture-worker",
            type: "function",
            function: { name: content.name, arguments: JSON.stringify(content.arguments) },
          },
        ],
      }
    : { role: "assistant", content };
  const chunk = (value: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}

test("capture completion reveals and focuses the Project Chat attachment destination, not its inspected subagent", async () => {
  test.setTimeout(120_000);
  const temporary = await mkdtemp(join(tmpdir(), "cake-capture-subagent-return-"));
  const project = join(temporary, "project");
  const cakeHome = join(temporary, "cake-home");
  const agentDirectory = join(cakeHome, "pi");
  const userData = join(temporary, "user-data");
  await Promise.all([
    mkdir(project),
    mkdir(agentDirectory, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData),
  ]);
  const gate = Promise.withResolvers<void>();
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (body.includes("hidden, temporary project investigator")) {
      await gate.promise;
      reply(response, "Worker finished.");
    } else if (++requests === 1) {
      reply(response, {
        name: "cake",
        arguments: {
          command: "subagents.start",
          input: { projectPath: project, task: "Inspect capture return navigation" },
        },
      });
    } else reply(response, "Parent ready.");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  await writeFile(
    join(agentDirectory, "models.json"),
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: "fixture",
          api: "openai-completions",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 200_000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  const presetId = "00000000-0000-4000-8000-000000000001";
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      version: 7,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: project,
            name: "Capture destination",
            addedAt: new Date(0).toISOString(),
            lastOpenedAt: new Date(0).toISOString(),
          },
        ],
        modelPresets: [
          {
            id: presetId,
            name: "Fixture",
            provider: "fixture",
            modelId: "fixture",
            thinkingLevel: "off",
            fastMode: false,
          },
        ],
        defaultModelPresetId: presetId,
      },
    }),
  );
  const repository = resolve(import.meta.dirname, "../..");
  const app = await electron.launch({
    args: [repository],
    cwd: repository,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_HOME: cakeHome,
      CAKE_ELECTRON_USER_DATA: userData,
      PI_CODING_AGENT_DIR: agentDirectory,
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    // Only native pixels/registration are faked. Keep real overlay, RPC, navigation and focus.
    await app.evaluate(
      ({ desktopCapturer, nativeImage, screen, systemPreferences, globalShortcut }) => {
        const image = nativeImage.createFromBitmap(Buffer.alloc(800 * 600 * 4, 255), {
          width: 800,
          height: 600,
        });
        desktopCapturer.getSources = async () => [
          {
            id: "screen:fixture",
            name: "Fixture display",
            display_id: String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id),
            thumbnail: image,
            appIcon: null,
          },
        ];
        systemPreferences.getMediaAccessStatus = () => "granted";
        globalShortcut.register = (_accelerator, callback) => {
          Reflect.set(globalThis, "subagentReturnCaptureShortcut", callback);
          return true;
        };
        globalShortcut.unregister = () => {};
      },
    );
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Open Project Chat for Capture destination", exact: true })
      .click();
    const composer = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await composer.fill(
      "Use a fresh-context read-only investigator to inspect capture return navigation.",
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Parent ready.", { exact: true })).toBeVisible();
    await composer.click();
    await composer.pressSequentially("Retained destination draft");
    await page.getByRole("button", { name: "Activity · 1 running", exact: true }).click();
    await page
      .getByRole("button", {
        name: "Inspect subagent: Inspect capture return navigation",
        exact: true,
      })
      .click();
    const inspection = page.getByRole("region", { name: "Subagent", exact: true });
    await expect(
      page.getByRole("navigation", { name: "Conversation breadcrumb" }).getByRole("button", {
        name: "Inspect capture return navigation",
        exact: true,
      }),
    ).toBeVisible();
    await expect(inspection).toBeVisible();
    const captures = join(repository, ".visual-captures");
    await mkdir(captures, { recursive: true });
    await page.screenshot({ path: join(captures, "capture-project-chat-return-before.png") });
    const openCapture = async () => {
      await expect
        .poll(() =>
          app.evaluate(() => typeof Reflect.get(globalThis, "subagentReturnCaptureShortcut")),
        )
        .toBe("function");
      const opened = app.waitForEvent("window");
      await app.evaluate(() => Reflect.get(globalThis, "subagentReturnCaptureShortcut")());
      const overlay = await opened;
      await expect(overlay.getByRole("toolbar", { name: "Screen capture tools" })).toBeVisible();
      return overlay;
    };
    let overlay = await openCapture();
    await overlay.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(inspection).toBeVisible();
    overlay = await openCapture();
    await expect(
      overlay.getByRole("button", { name: "Screenshot destination", exact: true }),
    ).toContainText("Capture destination");
    await overlay.getByRole("button", { name: "Attach full display", exact: true }).click();
    await expect(inspection).toHaveCount(0);
    await expect(composer).toBeVisible();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Retained destination draft");
    await expect(
      page.getByRole("button", { name: /^View [a-z0-9]{3}\.png enlarged$/ }),
    ).toHaveCount(1);
    await page.screenshot({ path: join(captures, "capture-project-chat-return-after.png") });
    await composer.press("End");
    await composer.pressSequentially(" with screenshot");
    await expect(composer).toHaveValue("Retained destination draft with screenshot");
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
      ),
    ).toBe(true);
  } finally {
    gate.resolve();
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temporary, { recursive: true, force: true });
  }
});
