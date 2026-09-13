import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`React Flow widget paths and sandbox (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-widget-flow-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("widget-pipeline-explanation")!;
    await scenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
      },
    });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: theme });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 900),
      );
      await scenario.prepare(page, "default");
      for (const fullscreen of [false, true]) {
        if (fullscreen)
          await page
            .getByRole("button", { name: "View Widget publication paths fullscreen" })
            .click();
        const iframe = page.locator(
          `iframe[title="Widget publication paths${fullscreen ? " fullscreen" : ""}"]`,
        );
        const frame = iframe.contentFrame();
        await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
        await expect(iframe).toHaveAttribute("src", /^cake-widget:/);
        await expect(frame.locator(".react-flow__node")).toHaveCount(8);
        await expect(frame.locator(".react-flow__edge")).toHaveCount(8);
        const geometry = await frame.locator("body").evaluate(() => ({
          overflow: document.body.scrollWidth > document.body.clientWidth,
          clipped: [...document.querySelectorAll(".graph-node strong, .graph-node small")].some(
            (label) => label.scrollWidth > label.clientWidth,
          ),
          node: "process" in globalThis,
          bridge: "cake" in globalThis,
          request: "cakeRequest" in globalThis,
          parentBlocked: (() => {
            try {
              return !window.parent.document;
            } catch {
              return true;
            }
          })(),
        }));
        expect(geometry).toEqual({
          overflow: false,
          clipped: false,
          node: false,
          bridge: false,
          request: false,
          parentBlocked: true,
        });
        await frame.getByRole("button", { name: "Repair loop", exact: true }).click();
        await expect(frame.getByRole("heading", { name: "One repair" })).toBeVisible();
        await expect(frame.locator('.react-flow__edge[data-id="diagnostic"]')).toHaveClass(
          /highlighted/,
        );
        await expect(frame.locator('.react-flow__edge[data-id="brief"]')).toHaveClass(/muted/);
        const evidence = frame.getByRole("button", { name: "Source evidence" });
        await evidence.focus();
        await evidence.press("Enter");
        await expect(
          frame.getByText(/ProjectSessionIntegrationHost.ts · generateInlineWidget/),
        ).toBeVisible();
        await frame.getByRole("button", { name: "Neighbors", exact: true }).click();
        const widget = frame.locator('.react-flow__node[data-id="widget"]');
        await widget.focus();
        await widget.press("Enter");
        await expect(frame.getByRole("heading", { name: "Interactive widget" })).toBeVisible();
        await expect(frame.locator('.react-flow__edge[data-id="embed"]')).toHaveClass(
          /highlighted/,
        );
        await expect(frame.locator('.react-flow__edge[data-id="publish"]')).toHaveClass(/muted/);
        await frame.locator('.react-flow__node[data-id="repository"]').click();
        await expect(frame.getByRole("heading", { name: "Artifact record" })).toBeVisible();
        await expect(frame.locator(".react-flow__edge.highlighted")).toHaveCount(3);
        if (fullscreen) {
          const box = await iframe.boundingBox();
          expect(box!.width).toBeGreaterThan(1200);
          await page
            .getByRole("button", { name: "Exit fullscreen Widget publication paths" })
            .click();
          await expect(page.getByRole("dialog")).toHaveCount(0);
        }
      }
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
