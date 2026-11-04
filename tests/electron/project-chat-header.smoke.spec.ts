import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");

for (const { mode, chatSidebarVisible, width } of [
  { mode: "normal", chatSidebarVisible: true, width: 1400 },
  { mode: "browser", chatSidebarVisible: true, width: 1400 },
  { mode: "vscode", chatSidebarVisible: true, width: 1400 },
  { mode: "browser", chatSidebarVisible: false, width: 800 },
  { mode: "vscode", chatSidebarVisible: false, width: 800 },
]) {
  test(`${mode} header opens the owning Project Chat (chat sidebar: ${chatSidebarVisible}) and reuses its pane`, async () => {
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
        }),
      );
      const snapshot = JSON.parse(windowState({ project, sessionId, projects: [project, other] }));
      snapshot.data.children.sessionRegistry.children.sessions[0].state.workspaceChatSidebarVisible =
        chatSidebarVisible;
      snapshot.data.children.sidebarStore = {
        state: { visible: chatSidebarVisible },
        children: {},
      };
      await writeFile(join(userData, "window-state.json"), JSON.stringify(snapshot));
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
      await page.setViewportSize({ width, height: 900 });
      if (mode !== "normal") {
        await page
          .getByRole("button", {
            name: mode === "browser" ? "Open Browser Mode" : "Open VS Code",
            exact: true,
          })
          .click();
        await expect(
          page.getByRole("region", {
            name: mode === "browser" ? "Browser workspace" : "VS Code workspace",
            exact: true,
          }),
        ).toBeVisible();
        if (mode === "browser") {
          const address = page.getByRole("textbox", { name: "Browser address" });
          await address.fill("about:blank");
          await address.press("Enter");
          await expect(address).toHaveValue("about:blank");
        }
      }
      const headers = page.locator('[data-slot="workspace-header"]');
      const projectLink = () =>
        page.getByRole("button", { name: "Go to Project Chat for Alpha", exact: true });
      await expect(projectLink()).toBeVisible();
      const artwork = await projectLink().locator('[data-slot="avatar"] img').getAttribute("src");
      await projectLink().hover();
      await expect(
        page.getByRole("tooltip", { name: "Go to Project Chat for Alpha", exact: true }),
      ).toBeVisible();
      const bounds = await projectLink().boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      if (mode === "normal") {
        // Shift+Tab retains native navigation; Enter activates the actual button.
        await projectLink().focus();
        await page.keyboard.press("Tab");
        await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeFocused();
        await headers.locator('[data-slot="workspace-actions"] button:visible').first().focus();
        await page.keyboard.press("Shift+Tab");
        await expect(projectLink()).toBeFocused();
        await page.keyboard.press("Enter");
      } else {
        // Native workspace content must not intercept the link's pointer target.
        await projectLink().click();
      }
      const pane = page.locator(`[data-slot="session-pane"][data-session-id="${projectId}"]`);
      await expect(pane).toBeVisible();
      await expect(projectLink().locator('[data-slot="avatar"] img')).toHaveAttribute(
        "src",
        artwork!,
      );
      const paneId = await pane.getAttribute("data-pane-id");
      const input = page.getByRole("combobox", { name: "Message Project Chat" });
      await input.click();
      await expect(input).toBeFocused();
      await input.pressSequentially("Keep this project draft");
      await expect(input).toHaveValue("Keep this project draft");
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
}
