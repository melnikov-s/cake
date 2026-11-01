import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario, seedArtifact } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const kind of ["widget", "html"] as const) {
  for (const entry of ["inline", "menu"] as const) {
    test(`tall fullscreen ${kind} artifacts scroll from ${entry}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "cake-widget-scroll-"));
      const paths = {
        cakeHome: join(root, "cake-home"),
        project: join(root, "project"),
        userData: join(root, "user-data"),
      };
      const theme = entry === "inline" ? "light" : "dark";
      await findVisualCaptureScenario("inline-artifact")!.seed(paths, theme);
      if (kind === "html")
        await seedArtifact(
          paths,
          {
            protocol: "cake.artifact/v1",
            id: "inline-visual",
            sessionId: "visual-inline-artifact",
            revision: 1,
            kind: "html",
            title: "Inline visualization",
            payload: {
              height: 1600,
              html: '<main style="height:6000px;display:flex;flex-direction:column;justify-content:space-between"><h1>Tall HTML</h1><div data-testid="tall-bottom">Bottom of tall artifact</div></main>',
            },
            fallback: { markdown: "Tall HTML" },
            interaction: { mode: "present" },
          },
          new Date(0).toISOString(),
        );
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
        await expect(page.getByRole("combobox", { name: "Message", exact: true })).toBeVisible();
        await expect(page.getByText("Opening session", { exact: true })).not.toBeVisible();
        const transcript = page
          .locator('.transcript:not([data-slot="content-transition-outgoing"] *)')
          .first();
        const inline = transcript.locator('[data-slot="artifact-disclosure"]').first();
        const inlineFrame = inline.locator("iframe");
        await expect(inlineFrame).toBeVisible();
        if (kind === "widget")
          await expect(
            inlineFrame.contentFrame().getByRole("button", { name: "Explore detail" }),
          ).toBeVisible();
        const inlineSrc = await inlineFrame.getAttribute("src");
        expect(
          await inlineFrame.evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(kind === "widget" ? 600 : 1600);
        if (entry === "menu") {
          await page.getByRole("button", { name: "1 artifacts", exact: true }).click();
          await page
            .getByRole("dialog", { name: "Artifacts", exact: true })
            .getByRole("button", { name: /Inline visualization/ })
            .click();
          await page
            .getByRole("complementary", { name: "Inline visualization", exact: true })
            .getByRole("button", { name: "View Inline visualization fullscreen" })
            .click();
        } else {
          const expand = inline.getByRole("button", {
            name: "View Inline visualization fullscreen",
          });
          // Read the artifact header before activating it. A tall inline frame starts
          // below the fold; scrolling a click target during activation can change the virtual range.
          await expect(async () => {
            const bounds = (await transcript.boundingBox())!;
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            await page.mouse.wheel(0, -100000);
            await expect(expand).toBeInViewport({ ratio: 1, timeout: 1000 });
          }).toPass({ timeout: 20_000 });
          await expand.click();
        }
        const surface = page.getByRole("dialog", { name: "Inline visualization", exact: true });
        const iframe = surface.locator("iframe");
        await expect(iframe).toBeVisible();
        const content = (await (await iframe.elementHandle())!.contentFrame())!;
        const frame = iframe.contentFrame();

        if (kind === "widget") {
          await expect(frame.getByRole("button", { name: "Explore detail" })).toBeVisible();
          const canvasHeight = await frame
            .getByTestId("canvas")
            .evaluate((element) => element.getBoundingClientRect().height);
          expect(canvasHeight).toBeGreaterThan((await iframe.boundingBox())!.height - 250);
          await frame.getByRole("button", { name: "Explore detail" }).click();
          await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
          // Simulate content growing after an interactive widget has mounted.
          await frame.locator("main").evaluate((main) => {
            main.style.height = "6000px";
            const bottom = document.createElement("div");
            bottom.textContent = "Bottom of tall artifact";
            bottom.dataset.testid = "tall-bottom";
            main.append(bottom);
          });
        }
        // Give native scrollbars a deterministic hit target even on macOS systems
        // configured to hide overlay scrollbars until a physical gesture.
        await content.evaluate(() => {
          const style = document.createElement("style");
          style.textContent =
            "::-webkit-scrollbar{width:14px}::-webkit-scrollbar-thumb{background:GrayText}";
          document.head.append(style);
        });
        const bounds = (await iframe.boundingBox())!;
        const viewportHeight = await page.evaluate(() => innerHeight);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewportHeight);
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        const bottomInView = () =>
          content.evaluate(() => {
            const rect = document
              .querySelector('[data-testid="tall-bottom"]')!
              .getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= innerHeight;
          });
        await page.mouse.wheel(0, 10000);
        await expect.poll(bottomInView).toBe(true);
        await content.evaluate(() => {
          window.scrollTo(0, 0);
          document.body.scrollTop = 0;
        });
        await expect.poll(bottomInView).toBe(false);
        const scrollbarX = bounds.x + bounds.width - 9;
        await page.mouse.move(scrollbarX, bounds.y + 25);
        await page.mouse.down();
        await page.mouse.move(scrollbarX, bounds.y + bounds.height - 10, { steps: 10 });
        await page.mouse.up();
        await expect.poll(bottomInView).toBe(true);
        // Resizing and the conversation drawer must not turn the iframe back
        // into a clipped inline-height surface or reload interactive state.
        await page.setViewportSize({ width: 900, height: 650 });
        await surface.getByRole("button", { name: "Open chat", exact: true }).click();
        const resized = (await iframe.boundingBox())!;
        expect(resized.y + resized.height).toBeLessThanOrEqual(650);
        await page.mouse.move(resized.x + resized.width / 2, resized.y + resized.height / 2);
        await page.mouse.wheel(0, 10000);
        await expect.poll(bottomInView).toBe(true);
        if (kind === "widget")
          await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
        await surface.getByRole("button", { name: "Exit fullscreen Inline visualization" }).click();
        await expect(surface).not.toBeAttached();
        expect(
          await inlineFrame.evaluate((element) => element.getBoundingClientRect().height),
        ).toBe(kind === "widget" ? 600 : 1600);
        if (kind === "widget" && entry === "inline") {
          await expect(inlineFrame).toHaveAttribute("src", inlineSrc!);
          await expect(
            inlineFrame.contentFrame().getByRole("button", { name: "Hide detail" }),
          ).toBeVisible();
        }
      } finally {
        await app.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
