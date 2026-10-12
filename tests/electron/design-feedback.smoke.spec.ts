import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function renderFeedback(root: string) {
  // Playwright's JSX runtime produces test descriptors rather than React nodes.
  // Compile the real primitives with React's JSX runtime for this static preview.
  const outfile = join(root, "feedback.cjs");
  await build({
    stdin: {
      resolveDir: repositoryRoot,
      loader: "tsx",
      contents: `
        import { renderToStaticMarkup } from "react-dom/server";
        import { Badge } from "./src/renderer/components/ui/badge";
        import { Callout } from "./src/renderer/components/ui/callout";
        import { StatusDot } from "./src/renderer/components/ui/status-dot";
        process.stdout.write(renderToStaticMarkup(
          <section id="design-feedback-fixture" className="bg-card">
            {["accent", "success", "destructive"].map(variant =>
              <Badge key={variant} variant={variant} data-testid={variant}>{variant}</Badge>
            )}
            <Callout variant="warning" data-testid="warning">Warning</Callout>
            <Callout variant="info" data-testid="info">Information</Callout>
            <StatusDot status="running" data-testid="running" />
            <StatusDot status="interrupted" data-testid="interrupted" />
          </section>
        ));`,
    },
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    outfile,
  });
  return (await promisify(execFile)(process.execPath, [outfile])).stdout;
}

// Sample Chromium's computed colors, compositing translucent surfaces over their
// real ancestors. These are presentation tests, not simulated workflow state.
async function contrast(locator: Locator) {
  return locator.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    const luminance = () => {
      const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
    };
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement)
      ancestors.unshift(current);
    context.fillStyle = "white";
    context.fillRect(0, 0, 1, 1);
    for (const ancestor of ancestors) {
      context.fillStyle = getComputedStyle(ancestor).backgroundColor;
      context.fillRect(0, 0, 1, 1);
    }
    const background = luminance();
    context.fillStyle = getComputedStyle(element).color;
    context.fillRect(0, 0, 1, 1);
    const foreground = luminance();
    return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
  });
}

for (const theme of ["light", "dark"] as const) {
  test(`feedback remains readable and respects motion preference (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-design-feedback-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("assistant-markdown-code")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
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
      const page = await application.firstWindow();
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "no-preference" });
      await scenario.prepare(page, "default", application);

      // Render the real primitive implementations, not copied classes, under the
      // compiled app's stylesheet and theme. This covers variants not all present
      // in a single product fixture (in particular the success badge).
      const markup = await renderFeedback(root);
      await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), markup);
      const fixture = page.locator("#design-feedback-fixture");
      for (const variant of ["accent", "success", "destructive", "warning"])
        expect(
          await contrast(fixture.getByTestId(variant)),
          `${variant} text`,
        ).toBeGreaterThanOrEqual(4.5);
      const warning = fixture.getByTestId("warning");
      const warningColor = await warning.evaluate((element) => {
        const probe = document.createElement("span");
        probe.style.color = "var(--warning)";
        element.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      expect(await warning.evaluate((element) => getComputedStyle(element).borderLeftColor)).toBe(
        warningColor,
      );
      expect(
        await fixture
          .getByTestId("info")
          .evaluate((element) => getComputedStyle(element).borderLeftColor),
      ).not.toBe(warningColor);

      // The actual shared Chat gauge must retain readable text on rest and hover.
      const gauge = page.locator('[data-slot="chat"] [data-context-state]').first();
      const count = gauge.locator(":scope > span").last();
      await expect(count).toBeVisible();
      expect(await contrast(count)).toBeGreaterThanOrEqual(4.5);
      await gauge.hover();
      expect(await contrast(count)).toBeGreaterThanOrEqual(4.5);
      await page.mouse.move(1, 1);

      const running = fixture.getByTestId("running");
      const accessory = page.locator('[data-slot="composer-leading-accessory"]').first();
      await expect(accessory).toBeAttached();
      const runningColor = await running.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      for (const preference of ["no-preference", "reduce", "no-preference"] as const) {
        await page.emulateMedia({ reducedMotion: preference });
        await expect
          .poll(() => running.evaluate((element) => getComputedStyle(element).animationName))
          .toBe(preference === "reduce" ? "none" : "pulse");
        await expect
          .poll(() => accessory.evaluate((element) => getComputedStyle(element).transitionProperty))
          .toBe(preference === "reduce" ? "none" : "opacity, transform");
        expect(await running.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
          runningColor,
        );
      }
      const composer = page.getByRole("combobox", { name: "Message", exact: true });
      await composer.focus();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Design feedback draft");
      await expect(composer).toHaveValue("Design feedback draft");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
