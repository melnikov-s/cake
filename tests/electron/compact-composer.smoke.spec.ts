import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const [surface, theme] of [
  ["assistant", "dark"],
  ["assistant", "light"],
  ["companion", "dark"],
  ["companion", "light"],
  ["annotation", "dark"],
  ["annotation", "light"],
] as const) {
  test(`compact composer shares an optical centerline and expands without losing focus (${surface}, ${theme})`, async () => {
    test.setTimeout(60_000);
    const root = await mkdtemp(join(tmpdir(), "cake-compact-composer-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("compact-composer")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...scenario.environment?.(paths),
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await application.firstWindow();
      const annotation = surface === "annotation";
      const companion = surface === "companion";
      await scenario.prepare(
        page,
        annotation ? "annotation-placeholder" : companion ? "companion-placeholder" : "placeholder",
        application,
      );
      const dialog = page.getByRole("dialog", {
        name: annotation
          ? "Add annotation"
          : companion
            ? "Session assistant chat"
            : "Quick session assistant",
        exact: true,
      });
      const input = dialog.getByRole(annotation ? "textbox" : "combobox", {
        name: annotation
          ? "Annotation comment"
          : companion
            ? "Message session assistant"
            : "Ask session assistant",
        exact: true,
      });
      const send = dialog.getByRole("button", {
        name: annotation ? "Add annotation" : "Send",
        exact: true,
      });
      const voice = dialog.locator('[data-slot="dictation-indicator"] button');
      const layout = () =>
        input.evaluate((element: HTMLTextAreaElement) => {
          const form = element.closest("form")!;
          const voice = form.querySelector('[data-slot="dictation-indicator"] button')!;
          const submit = form.querySelector('button[type="submit"]')!;
          const center = (node: Element) => {
            const box = node.getBoundingClientRect();
            return box.top + box.height / 2;
          };
          const iconCenter = (node: Element) => {
            const svg = node.querySelector("svg");
            if (!svg)
              return center(node.querySelector('[data-slot="voice-meter"], [role="status"]')!);
            // Measure the painted path, not just the SVG's square viewport.
            const bounds = svg.getBBox();
            const point = new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            return point.matrixTransform(svg.getScreenCTM()!).y;
          };
          const style = getComputedStyle(element);
          const field = element.getBoundingClientRect();
          const canvas = document.createElement("canvas");
          const context = canvas.getContext("2d")!;
          context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          // A fixed cap-height sample measures the font baseline, not whether
          // the current placeholder happens to contain descending glyphs.
          const metrics = context.measureText("H");
          const lineHeight = parseFloat(style.lineHeight);
          const baseline =
            field.top +
            parseFloat(style.borderTopWidth) +
            parseFloat(style.paddingTop) +
            (lineHeight - metrics.fontBoundingBoxAscent - metrics.fontBoundingBoxDescent) / 2 +
            metrics.fontBoundingBoxAscent;
          const inkCenter =
            baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2;
          return {
            fontSize: parseFloat(style.fontSize),
            lineHeight,
            rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
            height: field.height,
            formHeight: form.getBoundingClientRect().height,
            voice: center(voice),
            send: center(submit),
            voiceInk: iconCenter(voice),
            sendInk: iconCenter(submit),
            textInk: inkCenter,
            lineCenter: field.top + parseFloat(style.paddingTop) + lineHeight / 2,
            overflow: form.scrollWidth > form.clientWidth,
            withinViewport:
              form.getBoundingClientRect().left >= 0 &&
              form.getBoundingClientRect().right <= window.innerWidth,
            controlsOrdered:
              voice.getBoundingClientRect().right <= field.left &&
              field.right <= submit.getBoundingClientRect().left,
            indent: parseFloat(style.textIndent),
            caretColor: style.caretColor,
            color: style.color,
          };
        });
      const expectCenterline = async () => {
        await expect(async () => {
          const geometry = await layout();
          expect(Math.abs(geometry.voice - geometry.send)).toBeLessThan(0.1);
          expect(Math.abs(geometry.lineCenter - geometry.send)).toBeLessThan(0.1);
          expect(Math.abs(geometry.voiceInk - geometry.sendInk)).toBeLessThan(0.5);
          // text-xs and text-sm share Cake's readable 0.875rem floor;
          // the composer retains the shared leading-6 line box on every surface.
          expect(geometry.fontSize).toBe(geometry.rootFontSize * 0.875);
          expect(geometry.lineHeight).toBe(geometry.rootFontSize * 1.5);
          expect(Math.abs(geometry.textInk - geometry.sendInk)).toBeLessThanOrEqual(
            companion ? 2 : 1,
          );
          expect(geometry.overflow).toBe(false);
          expect(geometry.withinViewport).toBe(true);
          expect(geometry.controlsOrdered).toBe(true);
          expect(geometry.indent).toBe(0);
          expect(geometry.caretColor).toBe(geometry.color);
        }).toPass({ timeout: 5_000 });
      };
      await voice.click();
      await expect(voice.locator('[data-slot="voice-meter"]')).toBeVisible();
      for (const width of companion ? [320, 620, 1000, 1600] : [620, 1000, 1600]) {
        await application.evaluate(({ BrowserWindow }, width) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          window.setMinimumSize(320, 320);
          window.setContentSize(width, 750);
        }, width);
        await input.fill("");
        await expect(input).toBeFocused();
        // An empty annotation still submits a text highlight; an empty chat cannot send.
        await expect(send).toBeEnabled({ enabled: annotation });
        await expect(voice).toBeVisible();
        await expectCenterline();
        const singleLine = await layout();
        if (companion) expect(singleLine.formHeight).toBeLessThanOrEqual(56);
        const draft = companion ? "A Companion draft" : "whats the difference between this";
        await input.pressSequentially(draft);
        await expect(input).toHaveValue(draft);
        await expect(input).toBeFocused();
        await expect(send).toBeEnabled();
        await expectCenterline();
        await voice.click();
        await expect(voice).toHaveAttribute("aria-pressed", "true");
        await expect(input).toBeFocused();
        await expectCenterline();
        await input.press("Shift+Tab");
        await expect(voice).toBeFocused();
        // Both assistant popovers capture Escape to dismiss; Tab follows their
        // inline DOM order. Annotation's voice control retains Escape-to-input.
        await voice.press(annotation ? "Escape" : "Tab");
        await expect(input).toBeFocused();
        await voice.click();
        await expect(voice).toHaveAttribute("aria-pressed", "false");
        await expect(voice.locator('[data-slot="voice-meter"]')).toBeVisible();
        await input.press("End");
        await input.press("Shift+Enter");
        await input.pressSequentially("Second line");
        await expect(input).toHaveValue(`${draft}\nSecond line`);
        expect((await layout()).height).toBeGreaterThan(singleLine.height);
        await input.fill("First line\nSecond line\nThird line\nFourth line");
        await expect(input).toBeFocused();
        await expect(send).toBeEnabled();
        const multiline = await layout();
        expect(multiline.height).toBeGreaterThan(singleLine.height);
        expect(Math.abs(multiline.voice - multiline.send)).toBeLessThan(0.1);
        expect(multiline.overflow).toBe(false);
        await input.fill("A wrapping draft with enough words to fill several lines. ".repeat(50));
        expect((await layout()).height).toBeLessThanOrEqual(160);
        await expect(input).toBeFocused();
        await input.fill("");
        await expectCenterline();
      }
      await voice.click();
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = () => new Promise<MediaStream>(() => {});
      });
      await voice.click();
      await expect(voice).toHaveAttribute("aria-busy", "true");
      await expect(voice.locator('[role="status"]')).toBeVisible();
      await expectCenterline();
      await expect(input).toBeFocused();
      await expect(send).toBeEnabled({ enabled: annotation });
      await voice.click();
      await page.evaluate(() => {
        navigator.mediaDevices.getUserMedia = async () => {
          throw new Error("Microphone unavailable");
        };
      });
      await voice.click();
      await expect(voice).toHaveClass(/text-destructive/);
      await expect(voice).toHaveAttribute("aria-busy", "false");
      await expectCenterline();
      await expect(input).toBeFocused();
      if (annotation) {
        await input.fill("Remember this passage");
        await input.press("Enter");
        await expect(dialog).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "View 1 annotation", exact: true }),
        ).toBeVisible();
        const parentInput = page.getByRole("combobox", { name: "Message", exact: true });
        await expect(parentInput).toHaveValue("Let’s refine the voice conversation together.");
      }
    } finally {
      await application.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
