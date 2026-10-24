import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { emitRendererEvent } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const language of ["react", "html"] as const) {
  test(`${language} retained widgets follow live Cake and System themes without losing interaction`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-widget-theme-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario(`widget-theme-${language}`)!;
    // Compile and retain once; all subsequent opens use these same saved bytes.
    await scenario.seed(paths, "dark");
    const app = await electron.launch({
      args: ["--force-device-scale-factor=1", repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000);
      });
      await page.emulateMedia({ colorScheme: "light" });
      await scenario.prepare(page, "expanded");
      const host = page.locator('[data-slot="artifact-disclosure"]').first();
      const iframe = host.locator("iframe");
      const frame = iframe.contentFrame();
      const reference = await host.getAttribute("data-artifact-reference");
      const initialSrc = await iframe.getAttribute("src");
      const initialTheme = () => frame.locator("main").getAttribute("data-initial-theme");
      expect(await initialTheme()).toBe("dark");
      await frame.getByRole("textbox", { name: "Draft" }).fill("My live draft");
      const designColor = await frame
        .locator(".design-color")
        .evaluate((node) => getComputedStyle(node).color);
      const assertTheme = async (theme: "light" | "dark") => {
        await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
        const tokens = await page.locator("html").evaluate((node) => {
          const css = getComputedStyle(node);
          const probe = document.createElement("span");
          node.append(probe);
          const colors = Object.fromEntries(
            ["background", "foreground", "border", "card"].map((name) => {
              probe.style.color = css.getPropertyValue(`--${name}`);
              return [name, getComputedStyle(probe).color];
            }),
          );
          probe.remove();
          return colors;
        });
        await expect
          .poll(() =>
            frame.locator("main").evaluate((node) => {
              const css = getComputedStyle(node);
              return {
                background: css.backgroundColor,
                foreground: css.color,
                border: css.borderTopColor,
                card: getComputedStyle(node.querySelector("aside")!).backgroundColor,
              };
            }),
          )
          .toEqual(tokens);
        await expect(frame.locator("html")).toHaveCSS("color-scheme", theme);
        await expect(frame.locator(".design-color")).toHaveCSS("color", designColor);
        await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      };
      const setTheme = async (theme: "light" | "dark" | "system") => {
        // Real window appearance operation -> Settings Store -> document -> frame bridge.
        await emitRendererEvent(app, {
          type: "project-session-control-requested",
          sessionId: `widget-theme-${language}`,
          controlRequestId: randomUUID(),
          invocation: {
            _tag: "InvokeAppControl",
            command: "settings.window.update",
            input: { section: "appearance", changes: { theme } },
          },
        });
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      };
      const assertInteraction = async () => {
        expect(await iframe.getAttribute("src")).toBe(initialSrc);
        expect(await initialTheme()).toBe("dark");
        await expect(frame.getByRole("textbox", { name: "Draft" })).toHaveValue("My live draft");
        await expect(frame.getByRole("button", { name: "Report details" })).toHaveAttribute(
          "aria-expanded",
          "true",
        );
      };
      await assertTheme("dark");
      for (const theme of ["light", "dark"] as const) {
        await setTheme(theme);
        await assertTheme(theme);
        await assertInteraction();
      }
      await setTheme("system");
      await assertTheme("light");
      for (const theme of ["dark", "light", "dark"] as const) {
        // Chromium emits real matchMedia changes in the host; no widget-local stub.
        await page.emulateMedia({ colorScheme: theme });
        await assertTheme(theme);
        await assertInteraction();
      }
      expect(
        await frame.locator("body").evaluate(() => {
          try {
            return !!parent.document.body;
          } catch {
            return false;
          }
        }),
      ).toBe(false);

      // Reopening under explicit Light and System must initialize from the current
      // host, not the dark theme at compilation or the previous frame's fragment.
      for (const preference of ["light", "system"] as const) {
        await host.getByRole("button", { name: "Live widget theme Collapse" }).focus();
        await host.getByRole("button", { name: "Live widget theme Collapse" }).press("Enter");
        await expect(iframe).toHaveCount(0);
        await setTheme(preference);
        await host.getByRole("button", { name: "Live widget theme Expand" }).focus();
        await host.getByRole("button", { name: "Live widget theme Expand" }).press("Enter");
        const effective = preference === "system" ? "dark" : "light";
        await assertTheme(effective);
        expect(await initialTheme()).toBe(effective);
        expect(await host.getAttribute("data-artifact-reference")).toBe(reference);
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
