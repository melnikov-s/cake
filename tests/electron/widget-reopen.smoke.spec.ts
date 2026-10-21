import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("a failed reopened widget document is reported and retry loads the same saved revision", async () => {
  test.setTimeout(45_000);
  const root = await mkdtemp(join(tmpdir(), "cake-widget-reopen-"));
  const paths = {
    cakeHome: join(root, "cake-home"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  await findVisualCaptureScenario("inline-artifact")!.seed(paths, "dark");
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
    );
    const capture = async (name: string) => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (
          await BrowserWindow.getAllWindows()[0]!.webContents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: true,
          })
        )
          .toPNG()
          .toString("base64"),
      );
      await writeFile(join(repositoryRoot, ".visual-captures", name), Buffer.from(png, "base64"));
    };
    const inline = page.locator('[data-slot="artifact-disclosure"]').first();
    const iframe = inline.locator("iframe");
    const heading = iframe.contentFrame().getByRole("heading", { name: "One artifact, two views" });
    await expect(heading).toBeVisible({ timeout: 20_000 });
    await expect(inline.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
    const reference = await inline.getAttribute("data-artifact-reference");
    const collapse = inline.getByRole("button", { name: "Inline visualization Collapse" });
    // Read the older view using a real gesture, not scrollIntoView (which is
    // not permission to leave the transcript's bottom-following mode).
    await page.locator(".transcript").hover({ position: { x: 20, y: 200 } });
    await page.mouse.wheel(0, -1000);
    await expect(collapse).toBeInViewport();
    await collapse.focus();
    await collapse.press("Enter");
    await expect(iframe).toHaveCount(0);
    await app.evaluate(({ session }) => {
      let failed = false;
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        const cancel = !failed && details.url.startsWith("cake-widget://document/");
        if (cancel) {
          failed = true;
          Reflect.set(globalThis, "failedWidgetNavigation", details.url);
        }
        callback({ cancel });
      });
    });
    const expand = inline.getByRole("button", { name: "Inline visualization Expand" });
    await expand.focus();
    await expand.press("Enter");
    await expect(iframe).toHaveCount(1);
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, "failedWidgetNavigation")))
      .toBeTruthy();
    const failedSrc = await iframe.getAttribute("src");
    await expect(inline.locator('[data-widget-view-ready="true"]')).toHaveCount(0);
    await expect(inline.getByRole("alert")).toContainText("did not finish loading", {
      timeout: 20_000,
    });
    const output = join(repositoryRoot, ".visual-captures");
    await mkdir(output, { recursive: true });
    await expect(inline.getByRole("alert")).toBeInViewport();
    await capture("widget-reopen-failed.png");
    const retry = inline.getByRole("button", { name: "Retry view" });
    await retry.focus();
    await retry.press("Enter");
    await expect(heading).toBeVisible();
    await expect(inline.locator('[data-widget-view-ready="true"]')).toHaveCount(1);
    expect(await iframe.getAttribute("src")).not.toBe(failedSrc);
    expect(await inline.getAttribute("data-artifact-reference")).toBe(reference);
    await expect(heading).toBeInViewport();
    await capture("widget-reopen-recovered.png");
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
