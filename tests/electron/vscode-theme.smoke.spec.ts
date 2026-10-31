import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { emitRendererEvent } from "./main-harness";
import { windowState } from "../fixtures/window-state";
import { vscodeColorThemeFixture } from "../fixtures/vscode-color-themes";

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
            return {
              theme: workbench?.classList.contains('vs-dark') ? 'dark' : workbench?.classList.contains('vs') ? 'light' : undefined,
              background: workbench ? getComputedStyle(workbench).getPropertyValue('--vscode-editor-background').trim() : undefined,
            };
          })()`);
            return { id: contents.id, ...theme };
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
      // Import JSONC and a sibling include as data; the running workbench keeps its identity.
      const imported = vscodeColorThemeFixture(initialTheme);
      const sourceDirectory = join(directory, "theme-source");
      await mkdir(join(sourceDirectory, "themes"), { recursive: true });
      const entryPath = join(
        sourceDirectory,
        initialTheme === "dark" ? "themes" : "",
        "imported.jsonc",
      );
      const basePath = join(sourceDirectory, "base.json");
      await writeFile(basePath, JSON.stringify({ colors: imported.colors }));
      await writeFile(
        entryPath,
        `// Theme data only\n${JSON.stringify({ ...imported, colors: undefined, include: initialTheme === "dark" ? "../base.json" : "./base.json" })}`,
      );
      await page.getByRole("complementary").getByLabel("Open settings", { exact: true }).click();
      await page.getByRole("button", { name: /^Appearance/ }).click();
      if (initialTheme === "dark") {
        await page
          .getByLabel("Import theme folder", { exact: true })
          .setInputFiles(sourceDirectory);
        await page
          .getByLabel("Theme source", { exact: true })
          .selectOption({ label: "theme-source/themes/imported.jsonc" });
      } else {
        await page
          .getByLabel("Import VS Code theme", { exact: true })
          .setInputFiles([entryPath, basePath]);
      }
      await expect(page.getByText(`Preview: ${imported.name}`)).toBeVisible();
      await expect(page.locator("html")).toHaveCSS(
        "--background",
        imported.colors["editor.background"],
      );
      await page.getByRole("button", { name: "Apply theme", exact: true }).click();
      await page.getByRole("button", { name: "Back to chat", exact: true }).click();
      await expect.poll(editorState, { timeout: 25_000 }).toMatchObject({
        id: editorId,
        theme: initialTheme,
        background: imported.colors["editor.background"],
      });
      await setTheme("light");
      await expect
        .poll(editorState)
        .toMatchObject({ id: editorId, theme: "light", background: "#f5f7f9" });

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
