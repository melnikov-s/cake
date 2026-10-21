import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");

test("header project icon opens the owning Project Chat with keyboard activation and reuses its pane", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-project-header-"));
  const project = join(directory, "alpha");
  const other = join(directory, "beta");
  const cakeHome = join(directory, "cake");
  const userData = join(directory, "user-data");
  const sessionId = "header-task";
  const projectId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
  const timestamp = new Date(0).toISOString();
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    const sessions = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(other, { recursive: true }),
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(userData, { recursive: true }),
    ]);
    await writeFile(
      join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        { type: "session_info", id: "name", parentId: null, timestamp, name: "Header task" },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [project, other].map((path) => ({
          path,
          name: path === project ? "Alpha" : "Beta",
          addedAt: timestamp,
          lastOpenedAt: timestamp,
        })),
        trustedProjectPaths: [project, other],
      }),
    );
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId, projects: [project, other] }),
    );
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: cakeHome,
        CAKE_ELECTRON_USER_DATA: userData,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1400, height: 900 });
    const headers = page.locator('[data-slot="workspace-header"]');
    const projectLink = () =>
      headers.getByRole("button", { name: "Go to Project Chat for Alpha", exact: true });
    await expect(projectLink()).toBeVisible();
    const artwork = await projectLink().locator('[data-slot="avatar"] img').getAttribute("src");
    await projectLink().hover();
    await expect(
      page.getByRole("tooltip", { name: "Go to Project Chat for Alpha", exact: true }),
    ).toBeVisible();
    // A native Tab establishes keyboard focus; Enter activates the actual button.
    await projectLink().focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(projectLink()).toBeFocused();
    await page.keyboard.press("Enter");
    const pane = page.locator(`[data-slot="session-pane"][data-session-id="${projectId}"]`);
    await expect(pane).toBeVisible();
    await expect(projectLink().locator('[data-slot="avatar"] img')).toHaveAttribute(
      "src",
      artwork!,
    );
    const paneId = await pane.getAttribute("data-pane-id");
    const input = page.getByRole("combobox", { name: "Message Project Chat" });
    await input.fill("Keep this project draft");
    await projectLink().focus();
    await page.keyboard.press("Space");
    await expect(pane).toHaveAttribute("data-pane-id", paneId!);
    await expect(page.locator('[data-slot="session-pane"]')).toHaveCount(1);
    await expect(input).toHaveValue("Keep this project draft");
    await projectLink().click();
    await expect(pane).toHaveAttribute("data-pane-id", paneId!);
    await expect(input).toHaveValue("Keep this project draft");
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
