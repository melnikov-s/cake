import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import type { JsonObject } from "../../src/contracts/serialization/json-contract";
import { emitRendererEvent } from "./main-harness";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const codeServer = "/opt/homebrew/bin/code-server";

test("theme tools persist, refresh Settings and drive the same live Cake/native editor theme across restart", async () => {
  test.skip(!existsSync(codeServer), "Requires a local code-server installation");
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-theme-tools-"));
  const project = join(directory, "project");
  const userData = join(directory, "desktop");
  const home = join(directory, "cake-home");
  const sessionId = "theme-tool-source";
  const sessions = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
  await mkdir(sessions, { recursive: true });
  await Promise.all(
    [project, userData, join(home, "state")].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(join(project, "hello.ts"), "export const value = 42;\n");
  await writeFile(
    join(userData, "window-state.json"),
    windowState({ project, sessionId, theme: "light" }),
  );
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(home, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Theme tools", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
      vscodeServerPath: codeServer,
    }),
  );
  await writeFile(
    join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    [
      { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: [{ type: "text", text: "Theme tools fixture" }],
          timestamp: 0,
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: home,
        PI_CODING_AGENT_DIR: join(home, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  let application = await launch();
  try {
    let page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    const invoke = (command: string, input: JsonObject) =>
      emitRendererEvent(application, {
        type: "project-session-control-requested",
        sessionId,
        controlRequestId: randomUUID(),
        invocation: { _tag: "InvokeAppControl", command, input },
      });
    const savedAppearance = async () =>
      JSON.parse(await readFile(join(userData, "window-state.json"), "utf8")).data.children
        .settingsStore.children.appearance.state;
    await page.getByRole("button", { name: "VS Code", exact: true }).click({ timeout: 20_000 });
    await expect(
      page.getByRole("region", { name: "VS Code workspace", exact: true }),
    ).toBeVisible();
    const editor = () =>
      application.evaluate(async ({ webContents }) => {
        for (const contents of webContents.getAllWebContents()) {
          if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
          return {
            id: contents.id,
            ...(await contents.executeJavaScript(`(() => {
          const workbench = document.querySelector('.monaco-workbench');
          return { background: workbench ? getComputedStyle(workbench).getPropertyValue('--vscode-editor-background').trim() : undefined };
        })()`)),
          };
        }
        return undefined;
      });
    await expect.poll(editor, { timeout: 25_000 }).toMatchObject({ background: "#f5f7f9" });
    const editorId = (await editor())?.id;
    await invoke("themes.add", {
      name: "Tool Halloween",
      theme: {
        type: "dark",
        colors: {
          "editor.background": "#191322",
          "editor.foreground": "#f4e6d5",
          "button.background": "#ed8a27",
        },
        tokenColors: [{ scope: "keyword", settings: { foreground: "#ffaa33" } }],
      },
    });
    await expect.poll(async () => (await savedAppearance()).importedThemes?.length).toBe(1);
    const custom = (await savedAppearance()).importedThemes[0];
    const choice = `imported:${custom.id}`;
    // Adding is intentionally invisible; selecting an inactive slot must stay invisible too.
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await invoke("themes.apply", { choice, application: "when-active" });
    await expect.poll(async () => (await savedAppearance()).darkTheme).toBe(choice);
    expect((await savedAppearance()).theme).toBe("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await invoke("themes.apply", { choice, application: "now" });
    await expect(page.locator("html")).toHaveCSS("--background", "#191322");
    await expect
      .poll(editor, { timeout: 25_000 })
      .toMatchObject({ id: editorId, background: "#191322" });
    await expect.poll(async () => (await savedAppearance()).theme).toBe("dark");
    // Shared Settings observes the same catalog, not a separate tool-owned registry.
    await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
    await page.getByRole("button", { name: /^Appearance/ }).click();
    await expect(
      page.getByRole("button", { name: "Tool Halloween theme", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Back to chat", exact: true }).click();
    await invoke("settings.window.update", { section: "appearance", changes: { theme: "system" } });
    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await expect
        .poll(editor)
        .toMatchObject({ id: editorId, background: mode === "dark" ? "#191322" : "#f5f7f9" });
    }
    await application.close();
    const persisted = await savedAppearance();
    expect(persisted).toMatchObject({
      theme: "system",
      lightTheme: "bundled:cake-light",
      darkTheme: choice,
    });
    expect(persisted.importedThemes[0]).toEqual(custom);
    application = await launch();
    page = await application.firstWindow();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveCSS("--background", "#191322", { timeout: 20_000 });
    const open = page.getByRole("button", { name: "VS Code", exact: true });
    if (await open.isVisible()) await open.click();
    await expect.poll(editor, { timeout: 25_000 }).toMatchObject({ background: "#191322" });
  } finally {
    await application.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
