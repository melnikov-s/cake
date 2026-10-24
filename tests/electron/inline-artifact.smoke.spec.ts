import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";
import { Effect, Layer, ManagedRuntime } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { ArtifactStorage } from "../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { addHistoricalWidgetToCatalog } from "../fixtures/historical-widget-catalog";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`artifact links validate browser payloads and saved visuals render inline (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-inline-artifact-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    await findVisualCaptureScenario("inline-artifact")!.seed(paths, theme);
    const artifactRoot = join(paths.cakeHome, "state", "artifacts");
    const storageRuntime = ManagedRuntime.make(
      makeArtifactStorageLive(artifactRoot).pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    );
    await storageRuntime.runPromise(
      Effect.flatMap(ArtifactStorage, (storage) => storage.catalog()),
    );
    await storageRuntime.dispose();
    await addHistoricalWidgetToCatalog(artifactRoot);
    const app = await electron.launch({
      args: [repositoryRoot],
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
      await page.emulateMedia({ colorScheme: theme });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
      );
      const disclosures = page.locator('[data-slot="artifact-disclosure"]');
      await expect(page.getByRole("button", { name: "1 artifacts" })).toBeVisible({
        timeout: 20000,
      });
      await page.getByRole("link", { name: "saved visualization" }).focus();
      await page.getByRole("link", { name: "saved visualization" }).press("Enter");
      const pane = page.locator('[data-artifact-id="inline-visual"]');
      await expect(page.getByLabel("Search artifact library")).toBeVisible();
      await expect(page.getByRole("button", { name: /Historical widget widget/ })).toBeVisible();
      await expect(
        page.getByText('Missing key at ["payload"]["browser"]', { exact: false }),
      ).not.toBeVisible();

      await expect(
        pane
          .locator("iframe")
          .contentFrame()
          .getByRole("heading", { name: "One artifact, two views" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
      const inline = disclosures.first();
      await expect(
        inline.getByRole("button", { name: "Inline visualization Collapse" }),
      ).toHaveAttribute("aria-expanded", "true");
      const iframe = inline.locator("iframe");
      const frame = iframe.contentFrame();
      await expect(frame.getByRole("heading", { name: "One artifact, two views" })).toBeVisible();
      await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-downloads");
      await expect(frame.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(frame.locator("html")).toHaveAttribute("data-presentation", "inline");
      await expect(frame.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
      // Artifact rows have their own cap; ordinary messages and prose retain their reading width.
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1800, 1100),
      );
      await expect
        .poll(() => inline.evaluate((element) => element.getBoundingClientRect().width))
        .toBeGreaterThan(900);
      await page
        .locator(".transcript")
        .first()
        .evaluate((element) => {
          element.scrollTop = 0;
        });
      const prose = page
        .locator(".markdown-content > p")
        .filter({ hasText: "saved visualization" })
        .first();
      expect((await prose.boundingBox())!.width).toBeLessThanOrEqual(727);
      const userMessage = page
        .locator('[data-slot="message-content"]')
        .filter({ hasText: "Explain how Cake" });
      expect((await userMessage.boundingBox())!.width).toBeLessThanOrEqual(672);
      const originalSrc = await iframe.getAttribute("src");
      const initialHeight = await iframe.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      expect(initialHeight).toBe(600);
      const resize = inline.getByRole("separator", { name: "Resize Inline visualization" });
      await resize.focus();
      await resize.press("ArrowDown");
      await expect(resize).toHaveAttribute("aria-valuenow", "616");
      const grip = (await resize.boundingBox())!;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 64);
      await page.mouse.up();
      await expect(resize).toHaveAttribute("aria-valuenow", "680");
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(680);
      const explore = frame.getByRole("button", { name: "Explore detail" });
      await explore.focus();
      await explore.press("Enter");
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      // An unsaved, purely local edit must survive moves, not just rehydrate
      // from durable artifact state in a newly created iframe.
      await frame.locator("main").evaluate((element) => {
        element.dataset.unsaved = "retained";
      });

      const nextTheme = theme === "light" ? "dark" : "light";
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, nextTheme);
      await expect(frame.locator("html")).toHaveAttribute("data-theme", nextTheme);
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      expect(await iframe.getAttribute("src")).toBe(originalSrc);
      const hostColor = await page.locator("body").evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--foreground)";
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect
        .poll(() => frame.locator("main").evaluate((element) => getComputedStyle(element).color))
        .toBe(hostColor);
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(680, 1000),
      );
      expect(
        await frame.locator("body").evaluate((body) => body.scrollWidth > body.clientWidth),
      ).toBe(false);
      const transcript = page.locator(".transcript").first();
      const assertContained = async () => {
        const bounds = (await inline.boundingBox())!;
        const available = (await transcript.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(available.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(available.x + available.width);
        expect(
          await transcript.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      };
      await assertContained();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 1000),
      );

      const isolation = await frame.locator("body").evaluate(async () => {
        let parentAccessible = false;
        try {
          parentAccessible = !!parent.document;
        } catch {
          // The opaque-origin sandbox must reject parent DOM access.
        }
        let networkAccessible = false;
        try {
          await fetch("https://example.com");
          networkAccessible = true;
        } catch {
          // The widget CSP must reject active network access.
        }
        return {
          parentAccessible,
          networkAccessible,
          node: "process" in globalThis,
          cake: "cake" in globalThis,
        };
      });
      expect(isolation).toEqual({
        parentAccessible: false,
        networkAccessible: false,
        node: false,
        cake: false,
      });
      // Rendering and interacting with a publication do not open its accessory panel.
      await expect(page.getByRole("complementary", { name: "Inline visualization" })).toHaveCount(
        0,
      );
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      // Exercise keyboard activation after native viewport resize; the evidence smoke
      // separately covers pointer activation of the same fullscreen control.
      const fullscreenExpand = inline.getByRole("button", {
        name: "View Inline visualization fullscreen",
      });
      await fullscreenExpand.focus();
      await fullscreenExpand.press("Enter");
      const fullscreen = page.getByRole("dialog", { name: "Inline visualization" });
      await expect(
        fullscreen
          .locator("iframe")
          .contentFrame()
          .getByRole("heading", { name: "One artifact, two views" }),
      ).toBeVisible();
      const fullFrame = fullscreen.locator("iframe");
      const fullContent = fullFrame.contentFrame();
      await expect(fullContent.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await expect(fullContent.locator("main")).toHaveAttribute("data-unsaved", "retained");
      expect(await fullFrame.getAttribute("src")).toBe(originalSrc);
      const assertFilled = async () => {
        const header = (await fullscreen.locator("header").boundingBox())!;
        const bounds = (await fullFrame.boundingBox())!;
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        expect(bounds.width).toBe(viewport.width);
        expect(bounds.height).toBeCloseTo(viewport.height - header.height, 0);
        expect(bounds.y).toBeCloseTo(header.height, 0);
        expect(
          await fullContent
            .locator("body")
            .evaluate((body) => body.scrollHeight > body.clientHeight),
        ).toBe(false);
        expect(
          await fullContent
            .getByTestId("canvas")
            .evaluate((element) => element.getBoundingClientRect().height),
        ).toBeGreaterThan(bounds.height - 250);
      };
      await assertFilled();
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.setContentSize(1000, 760),
      );
      await expect
        .poll(() => fullFrame.evaluate((element) => element.getBoundingClientRect().width))
        .toBe(1000);
      await assertFilled();
      await fullscreen
        .getByRole("button", { name: "Exit fullscreen Inline visualization" })
        .click();
      await expect(frame.locator("main")).toHaveAttribute("data-unsaved", "retained");
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await expect
        .poll(() => iframe.evaluate((element) => element.getBoundingClientRect().height))
        .toBe(680);
      await expect(resize).toHaveAttribute("aria-valuenow", "680");
      const collapse = inline.getByRole("button", { name: "Inline visualization Collapse" });
      await collapse.focus();
      await collapse.press("Enter");
      await expect(inline.locator("iframe")).toHaveCount(0);
      const expand = inline.getByRole("button", { name: "Inline visualization Expand" });
      await expand.focus();
      await expand.press("Enter");
      await expect(
        inline.locator("iframe").contentFrame().getByRole("button", { name: "Explore detail" }),
      ).toBeVisible();
      await expect(disclosures).toHaveCount(2);
      // Repeated collapse/re-expand must publish a fresh usable document, never a blank/stale frame.
      for (let cycle = 0; cycle < 3; cycle++) {
        const previousSrc = await inline.locator("iframe").getAttribute("src");
        await inline.getByRole("button", { name: "Inline visualization Collapse" }).click();
        await inline.getByRole("button", { name: "Inline visualization Expand" }).click();
        const reopened = inline.locator("iframe").contentFrame();
        await expect(
          reopened.getByRole("heading", { name: "One artifact, two views" }),
        ).toBeVisible();
        await expect(reopened.locator("html")).toHaveAttribute("data-cake-widget-ready", "true");
        expect(await inline.locator("iframe").getAttribute("src")).not.toBe(previousSrc);
      }
      // The real accessory pane reduces available chat space, rather than forcing the artifact wider.
      await page.getByRole("button", { name: "1 artifacts" }).click();
      await page
        .getByRole("dialog", { name: "Artifacts", exact: true })
        .getByRole("button", { name: /Inline visualization/ })
        .click();
      await assertContained();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
