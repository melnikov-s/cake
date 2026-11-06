import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("renders newly opened Project Chats immediately in an existing split", async () => {
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
    const panes = page.locator('[data-slot="session-pane"]');
    await expect(panes).toHaveCount(1, { timeout: 20_000 });
    await page.getByRole("button", { name: "Open Project Chat for alpha", exact: true }).click();
    const left = panes.nth(0);
    const leftInput = left.getByLabel("Message Project Chat");
    await expect(leftInput).toBeVisible();
    await leftInput.fill("alpha draft");
    const leftPaneId = await left.getAttribute("data-pane-id");
    const leftSessionId = await left.getAttribute("data-session-id");
    await left.getByRole("button", { name: "Split right" }).click();
    await expect(panes).toHaveCount(2);
    const right = panes.nth(1);
    const rightPaneId = await right.getAttribute("data-pane-id");
    const rightInput = right.getByLabel("Message Project Chat");
    await page.getByRole("button", { name: "Open Project Chat for beta", exact: true }).click();
    // No click, focus change, or navigation after opening: loading must update the pane itself.
    await expect(rightInput).toBeVisible();
    await expect(rightInput).toBeFocused();
    const transcript = right.locator(
      '[data-slot="chat"] > [data-slot="content-transition"] > [data-slot="content-transition-live"]',
    );
    await expect(transcript).not.toHaveClass(/opacity-0/);
    await expect(transcript).not.toHaveAttribute("aria-hidden", "true");
    await expect(transcript.getByText("Let’s talk about this project")).toBeVisible();
    const betaSessionId = await right.getAttribute("data-session-id");
    expect(betaSessionId).not.toBe(leftSessionId);
    await rightInput.pressSequentially("beta draft");
    await expect(rightInput).toHaveValue("beta draft");
    await expect(right.getByRole("button", { name: "Send" })).toBeEnabled();
    await page.getByRole("button", { name: "Open Project Chat for gamma", exact: true }).click();
    await expect(rightInput).toBeVisible();
    await expect(rightInput).toBeFocused();
    await expect(rightInput).toHaveValue("");
    await expect(transcript).not.toHaveClass(/opacity-0/);
    await expect(transcript).not.toHaveAttribute("aria-hidden", "true");
    await page.getByRole("button", { name: "Open Project Chat for beta", exact: true }).click();
    await expect(rightInput).toBeVisible();
    await expect(rightInput).toHaveValue("beta draft");
    await expect(transcript).not.toHaveClass(/opacity-0/);
    await expect(transcript).not.toHaveAttribute("aria-hidden", "true");
    await expect(right).toHaveAttribute("data-pane-id", rightPaneId!);
    await expect(right).toHaveAttribute("data-session-id", betaSessionId!);
    await expect(left).toHaveAttribute("data-pane-id", leftPaneId!);
    await expect(left).toHaveAttribute("data-session-id", leftSessionId!);
    await expect(leftInput).toHaveValue("alpha draft");
    const leftTranscript = left.locator(
      '[data-slot="chat"] > [data-slot="content-transition"] > [data-slot="content-transition-live"]',
    );
    await expect(leftTranscript).not.toHaveClass(/opacity-0/);
    await expect(leftTranscript).not.toHaveAttribute("aria-hidden", "true");
    await expect(leftTranscript.getByText("Let’s talk about this project")).toBeVisible();
    await expect(panes).toHaveCount(2);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
