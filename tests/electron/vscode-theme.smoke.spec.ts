import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { emitRendererEvent } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const codeServer = "/opt/homebrew/bin/code-server";

for (const initialTheme of ["dark", "light"] as const) {
  test(`native VS Code follows Cake ${initialTheme}, live changes, System and reopen`, async () => {
    test.skip(!existsSync(codeServer), "Requires a local code-server installation");
    test.setTimeout(90_000);
    const directory = await mkdtemp(join(tmpdir(), "cake-vscode-theme-"));
    const project = join(directory, "project");
    const userData = join(directory, "desktop");
    const home = join(directory, "cake-home");
    await Promise.all(
      [project, userData, join(home, "state")].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(join(project, "hello.ts"), "export const value = 42;\n");
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, theme: initialTheme }),
    );
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(home, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          { path: project, name: "Theme fixture", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
        trustedProjectPaths: [project],
        vscodeServerPath: codeServer,
      }),
    );
    const application = await electron.launch({
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
    try {
      const page = await application.firstWindow();
      const opposite = initialTheme === "dark" ? "light" : "dark";
      // Deliberately disagree with Cake: explicit window preferences must win.
      await application.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, opposite);
      const open = page.getByRole("button", { name: "Open VS Code", exact: true });
      await expect(open).toBeVisible({ timeout: 20_000 });
      await open.click();
      const editorState = () =>
        application.evaluate(async ({ webContents }) => {
          for (const contents of webContents.getAllWebContents()) {
            if (!contents.getURL().startsWith("http://127.0.0.1:")) continue;
            const theme = await contents.executeJavaScript(`(() => {
            const workbench = document.querySelector('.monaco-workbench');
            return workbench?.classList.contains('vs-dark') ? 'dark' : workbench?.classList.contains('vs') ? 'light' : undefined;
          })()`);
            return { id: contents.id, theme };
          }
          return undefined;
        });
      const expectTheme = async (theme: "light" | "dark") => {
        await expect.poll(editorState, { timeout: 25_000 }).toMatchObject({ theme });
      };
      await expectTheme(initialTheme);
      const editorId = (await editorState())?.id;
      const setTheme = async (theme: "light" | "dark" | "system") => {
        await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
        await page.getByRole("button", { name: /^Appearance/ }).click();
        await page.getByLabel("Color theme", { exact: true }).selectOption(theme);
        await page.getByRole("button", { name: "Back to chat", exact: true }).click();
        await expect(page.getByLabel("Color theme", { exact: true })).toHaveCount(0);
      };
      await setTheme(opposite);
      await expectTheme(opposite);
      await setTheme(initialTheme);
      await expectTheme(initialTheme);
      // Exercise a live preference update without hiding/reopening the native surface.
      for (const theme of [opposite, initialTheme]) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await expectTheme(theme);
        expect((await editorState())?.id).toBe(editorId);
      }
      // OS updates must not override an explicit Cake preference.
      await application.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, initialTheme);
      await application.evaluate(({ nativeTheme }, theme) => {
        nativeTheme.themeSource = theme;
      }, opposite);
      await expectTheme(initialTheme);
      await setTheme("system");
      // Drive the renderer media query directly: hidden Electron windows do not
      // reliably receive nativeTheme changes in this fixture.
      for (const theme of ["light", "dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await expect
          .poll(() =>
            page.evaluate(() => ({
              preference: document.documentElement.dataset.theme,
              dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
            })),
          )
          .toEqual({ preference: "system", dark: theme === "dark" });
        await expectTheme(theme);
      }
      await emitRendererEvent(application, {
        type: "embedded-editor-back-to-agent",
        workspacePath: project,
      });
      await expect(page.getByRole("region", { name: "VS Code workspace" })).toBeHidden();
      await setTheme("dark");
      await open.click();
      await expectTheme("dark");
      // Returning to the retained native view must not need a reload or app restart.
      expect((await editorState())?.id).toBe(editorId);
    } finally {
      await application.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
