import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("switches Project Session, Project Chat and Cake Chat workspaces and restores covered composers", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-staged-switching-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const cakeHome = join(temporaryRoot, "cake-home");
  const projects = [join(temporaryRoot, "first"), join(temporaryRoot, "second")];
  await Promise.all(
    [userData, join(cakeHome, "state"), ...projects].map((path) =>
      mkdir(path, { recursive: true }),
    ),
  );
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project: projects[0]!, projects }),
  );
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: projects.map((path, index) => ({
        path,
        name: index === 0 ? "first" : "second",
        addedAt: new Date(0).toISOString(),
        lastOpenedAt: new Date(0).toISOString(),
      })),
      trustedProjectPaths: projects,
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
    const composer = page.getByLabel("Message");
    await expect(composer).toBeVisible({ timeout: 20_000 });
    const newFirst = page.getByRole("button", { name: "New chat in first", exact: true });
    const newSecond = page.getByRole("button", { name: "New chat in second", exact: true });

    await newFirst.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("First project draft");
    await expect(composer).toHaveValue("First project draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    // Repeating New Chat in the same Project retains the staged conversation.
    await newFirst.click();
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("First project draft");

    // No existing-session detour should be needed to start in another Project.
    await newSecond.click();
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Second project draft");
    await expect(composer).toHaveValue("Second project draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await newFirst.click();
    await expect(composer).toHaveValue("First project draft");
    await expect(composer).toBeFocused();
    await newSecond.click();
    await expect(composer).toHaveValue("Second project draft");
    await expect(composer).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Open Project Chat for first", exact: true }).click();
    const projectChat = page.getByRole("combobox", { name: "Message Project Chat", exact: true });
    await expect(projectChat).toBeFocused();
    await projectChat.pressSequentially("Project Chat draft");
    await expect(projectChat).toHaveValue("Project Chat draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

    await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
    const cakeChat = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
    await expect(cakeChat).toBeFocused();
    await cakeChat.pressSequentially("Cake Chat draft");
    await expect(cakeChat).toHaveValue("Cake Chat draft");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Open settings", exact: true }).first().click();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await expect(cakeChat).toHaveValue("Cake Chat draft");

    await page.getByRole("button", { name: "Open Project Chat for first", exact: true }).click();
    await expect(projectChat).toHaveValue("Project Chat draft");
    await page.getByRole("button", { name: /^(?:\d+ artifacts|Artifacts)$/ }).click();
    await page.getByRole("button", { name: "Browse all artifacts", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "Search artifact library", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
    await expect(projectChat).toHaveValue("Project Chat draft");
    await newSecond.click();
    await expect(composer).toHaveValue("Second project draft");
    await expect(composer).toBeFocused();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
