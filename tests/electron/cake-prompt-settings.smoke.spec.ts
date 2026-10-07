import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/domain/application/application-data";
import { defaultCakePrompts } from "../../src/domain/application/cake-prompts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("prompt defaults remain placeholders while custom overrides persist, clear, and reset", async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), "cake-prompt-settings-"));
  const userData = join(root, "user-data");
  const cakeHome = join(root, "cake-home");
  const document = join(cakeHome, "state", "application.json");
  await Promise.all([
    mkdir(userData, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(document, JSON.stringify({ version: 6, data: defaultApplicationState() }));
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
      },
    });
  const savedPrompts = async () => JSON.parse(await readFile(document, "utf8")).data.cakePrompts;
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    await page.getByRole("button", { name: /^Instructions & prompts\b/ }).click();
    let prompt = page.getByRole("textbox", { name: "Commit before merge", exact: true });
    await expect(prompt).toHaveValue("");
    await expect(prompt).toHaveAttribute("placeholder", defaultCakePrompts().worktreeCommit);
    expect(await savedPrompts()).toEqual({});
    await prompt.click();
    await expect(prompt).toBeFocused();
    await prompt.pressSequentially("Commit only the intended work.");
    await expect(prompt).toHaveValue("Commit only the intended work.");
    await prompt.press("Tab");
    await expect.poll(savedPrompts).toEqual({ worktreeCommit: "Commit only the intended work." });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    // Window persistence restores Settings; reopen it only if a different surface is selected.
    if (await page.getByRole("button", { name: "Open settings", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
    }
    await page.getByRole("button", { name: /^Instructions & prompts\b/ }).click();
    prompt = page.getByRole("textbox", { name: "Commit before merge", exact: true });
    await expect(prompt).toHaveValue("Commit only the intended work.");
    await prompt.fill("");
    await prompt.press("Tab");
    await expect.poll(savedPrompts).toEqual({});
    await expect(prompt).toHaveAttribute("placeholder", defaultCakePrompts().worktreeCommit);
    await prompt.fill("Another custom prompt.");
    await prompt.press("Tab");
    await expect.poll(savedPrompts).toEqual({ worktreeCommit: "Another custom prompt." });
    await page
      .locator("#setting-prompt-worktree-commit")
      .getByRole("button", { name: "Reset", exact: true })
      .click();
    await expect(prompt).toHaveValue("");
    await expect.poll(savedPrompts).toEqual({});
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
