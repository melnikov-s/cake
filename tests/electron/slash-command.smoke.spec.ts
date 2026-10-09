import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { installLocalModelHttpGuard } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("selects and runs slash commands from the composer with the keyboard", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-slash-command-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  const home = join(temporaryRoot, "home");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "slash-fixture", object: "chat.completion.chunk", created: 0, model: "slash-fixture", choices: [{ index: 0, delta: { content: "Fixture response." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const skillDirectory = join(project, ".agents", "skills", "desktop-fixture");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(skillDirectory, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(cakeHome, "pi"), { recursive: true }),
  ]);
  await writeFile(
    join(cakeHome, "pi", "settings.json"),
    JSON.stringify({ defaultProvider: "slash-provider", defaultModel: "slash-fixture" }),
  );
  await writeFile(join(cakeHome, "pi", "auth.json"), "{}");
  await writeFile(
    join(cakeHome, "pi", "models.json"),
    JSON.stringify({
      providers: {
        "slash-provider": {
          name: "Slash provider",
          baseUrl: `${origin}/v1`,
          apiKey: "fixture-only",
          api: "openai-completions",
          models: [
            {
              id: "slash-fixture",
              name: "Slash fixture",
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
    join(skillDirectory, "SKILL.md"),
    "---\nname: desktop-fixture\ndescription: Desktop fixture skill\n---\nFixture.\n",
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [project],
    }),
  );

  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      LANG: process.env.LANG,
      HOME: home,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
    },
  });

  try {
    const page = await application.firstWindow();
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    expect(await installLocalModelHttpGuard(application, origin)).toEqual({
      allowedOrigin: origin,
      installed: true,
    });

    const initialHeight = await composer.evaluate((input) => input.getBoundingClientRect().height);
    // The inline assistant column reserves room for the voice control below it.
    expect(initialHeight).toBe(72);

    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("hello");
    await expect(composer).toHaveValue("hello");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();

    await composer.fill(Array.from({ length: 30 }, (_, index) => `Line ${index + 1}`).join("\n"));
    const expandedSize = await composer.evaluate((input) => ({
      height: input.getBoundingClientRect().height,
      scrollHeight: input.scrollHeight,
    }));
    expect(expandedSize.height).toBeGreaterThan(initialHeight);
    expect(expandedSize.height).toBeLessThanOrEqual(321);
    expect(expandedSize.scrollHeight).toBeGreaterThan(expandedSize.height);

    await composer.fill("existing prompt");
    await composer.press("Home");
    await composer.pressSequentially("/");
    await expect(page.getByRole("listbox", { name: "Slash commands" })).toBeVisible();
    await expect(page.getByRole("option", { name: /compact/ })).toHaveCount(0);
    await expect(page.getByRole("option", { name: /toolcompact/ })).toHaveCount(0);
    await composer.press("Tab");
    await expect(composer).toHaveValue("/model existing prompt");

    await composer.fill("/tree");
    await composer.press("Enter");
    await expect(page.getByRole("complementary", { name: "Session tree" })).toBeVisible();

    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await composer.fill("/skill:desktop");
    await expect(
      page.getByRole("option", { name: /skill:desktop-fixture Desktop fixture skill/ }),
    ).toBeVisible();
    await composer.press("Tab");
    await expect(composer).toHaveValue("/skill:desktop-fixture ");
    await composer.press("Enter");
    await expect(page.locator(".session-item.active")).toHaveCount(1, { timeout: 20_000 });
    await expect(composer).toHaveValue("");
  } finally {
    await application.close();
    server.closeAllConnections();
    server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
