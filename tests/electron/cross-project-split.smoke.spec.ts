import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("renders newly opened Project Chats immediately and keeps each chat's draft", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-cross-project-split-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const projects = ["alpha", "beta", "gamma"].map((name) => ({
    path: join(temporaryRoot, name),
    name,
    addedAt: new Date(0).toISOString(),
    lastOpenedAt: new Date(0).toISOString(),
  }));
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    ...projects.map(({ path }) => mkdir(path, { recursive: true })),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project: projects[0]!.path }));
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects,
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    // Arbitrary multi-conversation splits were removed with chat-first navigation (582d0fc7);
    // the one focused pane must still render each newly opened Project Chat immediately.
    const pane = page.locator('[data-slot="workspace"]');
    await expect(pane).toHaveCount(1, { timeout: 20_000 });
    const input = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    const transcript = page
      .locator(
        '[data-slot="chat"] > [data-slot="content-transition"] > [data-slot="content-transition-live"]',
      )
      .first();
    const expectRendered = async (timeout = 5_000) => {
      await expect(input).toBeVisible({ timeout });
      await expect(transcript).not.toHaveClass(/opacity-0/);
      await expect(transcript).not.toHaveAttribute("aria-hidden", "true");
    };
    await page.getByRole("button", { name: "Open Project Chat for alpha", exact: true }).click();
    // The first Project Chat waits for the permanent chat catalog after launch.
    await expectRendered(20_000);
    await input.fill("alpha draft");
    const alphaSessionId = await pane.getAttribute("data-session-id");
    await page.getByRole("button", { name: "Open Project Chat for beta", exact: true }).click();
    // No click, focus change, or navigation after opening: loading must update the pane itself.
    await expectRendered();
    await expect(input).toBeFocused();
    await expect(transcript.getByText("Let’s talk about this project")).toBeVisible();
    const betaSessionId = await pane.getAttribute("data-session-id");
    expect(betaSessionId).not.toBe(alphaSessionId);
    await input.pressSequentially("beta draft");
    await expect(input).toHaveValue("beta draft");
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Open Project Chat for gamma", exact: true }).click();
    await expectRendered();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: "Open Project Chat for beta", exact: true }).click();
    await expectRendered();
    await expect(input).toHaveValue("beta draft");
    await expect(pane).toHaveAttribute("data-session-id", betaSessionId!);
    await page.getByRole("button", { name: "Open Project Chat for alpha", exact: true }).click();
    await expectRendered();
    await expect(input).toHaveValue("alpha draft");
    await expect(pane).toHaveAttribute("data-session-id", alphaSessionId!);
    await expect(transcript.getByText("Let’s talk about this project")).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
