import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repository = resolve(import.meta.dirname, "../..");
const visible = "[data-scrollbar-visible]";

test("native transcript thumb fades only for transcript scrolling or a scrollbar grab", async ({}, testInfo) => {
  test.setTimeout(45_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-transcript-scrollbar-"));
  const cakeHome = join(directory, "cake-home");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await seedCakeChatHistory(
      cakeHome,
      Array.from({ length: 100 }, (_, index) => `Message line ${index + 1}`).join("\n"),
    );
    app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: join(directory, "user-data"),
        CAKE_HOME: cakeHome,
        PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 760 });
    await page.emulateMedia({ colorScheme: "light" });
    const composer = page.getByRole("combobox", { name: "Message Cake Chat" });
    await expect(composer).toBeVisible();
    const transcript = page.getByRole("region", { name: "Conversation", exact: true });
    const revealed = transcript.and(page.locator(visible));
    const handle = page.getByRole("separator", { name: "Resize Workspace", exact: true });
    const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
    const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    const gap = () =>
      transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    const top = () => transcript.evaluate((node) => node.scrollTop);
    const height = () => transcript.evaluate((node) => node.clientHeight);
    await expect.poll(height).toBeGreaterThan(0);
    const viewportHeight = await height();
    const atBottom = () => expect.poll(gap).toBeLessThanOrEqual(1);
    const idle = () => expect(revealed).toHaveCount(0);
    const jumpToBottom = async () => {
      const count = await revealCount();
      await jump.click();
      await atBottom();
      await expect(jump).toHaveCount(0);
      expect(await revealCount()).toBe(count);
    };
    const geometry = () =>
      transcript.evaluate((node) => ({
        width: node.clientWidth,
        height: node.clientHeight,
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        gutter: node.offsetWidth - node.clientWidth,
        item: node.querySelector("[data-slot=transcript-item]")?.getBoundingClientRect().toJSON(),
      }));
    const thumb = (inset: number) =>
      transcript.evaluate((node, inset) => {
        const rect = node.getBoundingClientRect();
        const thumbHeight = Math.max(24, node.clientHeight ** 2 / node.scrollHeight);
        const progress = node.scrollTop / (node.scrollHeight - node.clientHeight);
        return {
          x: rect.right - inset,
          y: rect.top + progress * (node.clientHeight - thumbHeight) + thumbHeight / 2,
        };
      }, inset);
    const contrast = async () => {
      // Compare actual native thumb paint with the adjacent unpainted gutter.
      const { x, y } = await thumb(13);
      const png = await page.screenshot({
        clip: { x: Math.floor(x), y: Math.floor(y), width: 8, height: 1 },
        scale: "css",
      });
      return page.evaluate(
        async (bytes) => {
          const bitmap = await createImageBitmap(
            new Blob([Uint8Array.from(bytes)], { type: "image/png" }),
          );
          const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d")!;
          context.drawImage(bitmap, 0, 0);
          bitmap.close();
          const { data } = context.getImageData(0, 0, context.canvas.width, 1);
          const end = data.length - 4;
          return Math.max(
            ...[0, 1, 2].map((channel) => Math.abs(data[channel]! - data[end + channel]!)),
          );
        },
        [...png],
      );
    };
    const screenshot = (name: string) =>
      page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    const revealCount = () =>
      transcript.evaluate((node) => Number(node.getAttribute("data-test-scrollbar-reveals")));
    await atBottom();
    await transcript.evaluate((node) => {
      // Record even a one-frame flash during layout/scroll assertions.
      let count = 0;
      new MutationObserver((records) => {
        count += records.filter((record) => record.oldValue === null).length;
        node.setAttribute("data-test-scrollbar-reveals", String(count));
      }).observe(node, {
        attributeFilter: ["data-scrollbar-visible"],
        attributeOldValue: true,
      });
    });
    await expect.poll(contrast).toBeLessThanOrEqual(1);
    await screenshot("composer-before");
    const initialTop = await top();
    const initialComposerHeight = (await composer.boundingBox())!.height;
    await composer.focus();
    await page.keyboard.insertText("First line\nSecond line\nThird line\nFourth line\nFifth line");
    await expect
      .poll(async () => (await composer.boundingBox())!.height)
      .toBeGreaterThan(initialComposerHeight);
    await expect.poll(top).toBeGreaterThan(initialTop);
    await atBottom();
    await page.keyboard.press("ArrowUp");
    await expect(composer).toBeFocused();
    expect(
      await composer.evaluate((node: HTMLTextAreaElement) => node.selectionStart),
    ).toBeLessThan("First line\nSecond line\nThird line\nFourth line\nFifth line".length);
    expect(await revealCount()).toBe(0);
    await expect.poll(contrast).toBeLessThanOrEqual(1);
    await screenshot("composer-expanded-hidden");
    await composer.fill("");
    await atBottom();

    for (const paneOpen of [true, false]) {
      if (paneOpen) await expect(handle).toBeVisible();
      else {
        await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
        await expect(handle).toHaveCount(0);
      }
      const pane = paneOpen ? await workspace.boundingBox() : null;
      const value = paneOpen ? await handle.getAttribute("aria-valuenow") : null;
      await atBottom();
      const rect = (await transcript.boundingBox())!;
      const surface = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const label = paneOpen ? "workspace-open" : "workspace-closed";
      // The shell's inset chat surface stops 5px before the open Workspace.
      if (paneOpen) expect(pane!.x - (rect.x + rect.width)).toBeCloseTo(5, 0);
      const idleGeometry = await geometry();
      // A 16px native gutter plus 5px splitter clearance on the right, mirrored on the left so
      // transcript content centers in the window under the composer.
      expect(idleGeometry.gutter).toBe(2 * (16 + 5));
      const count = await revealCount();
      await page.mouse.move(rect.x + rect.width - 13, surface.y); // Track hover.
      await page.mouse.move((await thumb(13)).x, (await thumb(13)).y); // Thumb hover.
      await expect.poll(contrast).toBeLessThanOrEqual(1);
      expect(await revealCount()).toBe(count);
      expect(await geometry()).toEqual(idleGeometry);
      await screenshot(`${label}-idle-hover`);

      await page.mouse.move(surface.x, surface.y);
      await page.mouse.wheel(0, -850);
      await expect.poll(gap).toBeGreaterThan(viewportHeight);
      await expect(revealed).toHaveCount(1);
      // Keep scrolling beyond the first wheel event's idle deadline.
      for (let index = 0; index < 6; index++) {
        await page.waitForTimeout(110);
        await page.mouse.wheel(0, -75);
      }
      await expect.poll(gap).toBeGreaterThan(1200);
      await expect.poll(contrast).toBeGreaterThan(12);
      expect(await revealCount()).toBe(count + 1);
      await idle();
      await expect.poll(contrast).toBeLessThanOrEqual(1);
      const beforeProgrammatic = await revealCount();
      const beforeTop = await top();
      await transcript.evaluate((node) => (node.scrollTop += 200));
      await expect.poll(top).toBeGreaterThan(beforeTop);
      await jumpToBottom();
      expect(await revealCount()).toBe(beforeProgrammatic);

      // Freeze a real CSS transition before advancing its clock. This lets us
      // inspect actual intermediate paint without racing a 140ms transition.
      const pauseNextFade = () =>
        transcript.evaluate((node) => {
          node.addEventListener("transitionrun", () => node.getAnimations()[0]?.pause(), {
            once: true,
          });
        });
      const sampleFade = async (fraction: number) => {
        await expect
          .poll(() => transcript.evaluate((node) => node.getAnimations()[0]?.playState))
          .toBe("paused");
        await transcript.evaluate((node, fraction) => {
          const animation = node.getAnimations()[0]!;
          animation.currentTime = Number(animation.effect!.getComputedTiming().duration) * fraction;
        }, fraction);
        return contrast();
      };
      const finishFade = () => transcript.evaluate((node) => node.getAnimations()[0]?.finish());
      for (const inset of [6, 20]) {
        // Grab the hidden thumb on both sides, including the side nearest the divider.
        const point = await thumb(inset);
        const captureFade = paneOpen && inset === 6;
        if (captureFade) await pauseNextFade();
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try {
          await expect(revealed).toHaveCount(1);
          expect(await gap()).toBeLessThanOrEqual(1); // No track jump.
          expect(await geometry()).toEqual(idleGeometry);
          if (captureFade) {
            const start = await sampleFade(0);
            await screenshot("fade-in-start");
            const middle = await sampleFade(0.5);
            await screenshot("fade-in-midpoint");
            await finishFade();
            const end = await contrast();
            await screenshot("fade-in-complete");
            expect(start).toBeLessThanOrEqual(1);
            expect(middle).toBeGreaterThan(start + 2);
            expect(end).toBeGreaterThan(middle + 2);
          }
          await page.mouse.move(rect.x + rect.width - 30, point.y - 310, { steps: 8 });
          await expect.poll(gap).toBeGreaterThan(viewportHeight);
          // Hold outside the gutter, without moving, longer than the idle delay.
          await page.waitForTimeout(600);
          expect(await contrast()).toBeGreaterThan(12);
          if (paneOpen) {
            await expect(handle).toHaveAttribute("aria-valuenow", value!);
            await expect(page.locator("main.select-none")).toHaveCount(0);
          }
          if (captureFade) await pauseNextFade();
        } finally {
          await page.mouse.up();
        }
        await expect(revealed).toHaveCount(1);
        await idle();
        if (captureFade) {
          const start = await sampleFade(0);
          await screenshot("fade-out-start");
          const middle = await sampleFade(0.5);
          await screenshot("fade-out-midpoint");
          await finishFade();
          const end = await contrast();
          await screenshot("fade-out-complete");
          expect(start).toBeGreaterThan(middle + 2);
          expect(middle).toBeGreaterThan(end + 2);
          expect(end).toBeLessThanOrEqual(1);
        }
        await expect.poll(contrast).toBeLessThanOrEqual(1);
        if (paneOpen) expect(await workspace.boundingBox()).toEqual(pane);
        await jumpToBottom();
      }
      // Native track press navigates without any prior hover reveal.
      await page.mouse.click(rect.x + rect.width - 13, surface.y);
      await expect.poll(gap).toBeGreaterThan(0);
      await expect(revealed).toHaveCount(1);
      await idle();
      await transcript.focus();
      await page.keyboard.press("End");
      await atBottom();
      await idle();
    }

    // A contained nested scroll does not move or reveal the transcript.
    const nested = await transcript.evaluate((node) => {
      const box = document.createElement("div");
      box.id = "nested-scroll-fixture";
      box.style.cssText =
        "position:absolute; inset:50px auto auto 50px; width:160px; height:100px; overflow:auto; overscroll-behavior:contain";
      const inner = document.createElement("div");
      inner.style.height = "500px";
      box.append(inner);
      node.append(box);
      box.scrollTop = 200;
      const rect = box.getBoundingClientRect();
      return { x: rect.x + 50, y: rect.y + 50 };
    });
    const beforeNested = await revealCount();
    await page.mouse.move(nested.x, nested.y);
    await page.mouse.wheel(0, -100);
    const box = page.locator("#nested-scroll-fixture");
    await expect.poll(() => box.evaluate((node) => node.scrollTop)).toBeLessThan(200);
    await atBottom();
    expect(await revealCount()).toBe(beforeNested);
    await box.evaluate((node) => node.remove());

    const cdp = await page.context().newCDPSession(page);
    const bounds = (await transcript.boundingBox())!;
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 3;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (const offset of [35, 75, 120, 180])
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + offset }],
      });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(gap).toBeGreaterThan(30);
    await expect(revealed).toHaveCount(1);
    await idle();
    await cdp.detach();

    await transcript.focus();
    await expect(transcript).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect(revealed).toHaveCount(1);
    await idle();
    await page.keyboard.press("End");
    await atBottom();
    await expect(transcript).toBeFocused();
    await idle();

    const beforeResize = await revealCount();
    await page.setViewportSize({ width: 1280, height: 680 });
    await expect.poll(height).toBeLessThan(viewportHeight);
    await atBottom();
    expect(await revealCount()).toBe(beforeResize);

    await page.emulateMedia({ reducedMotion: "reduce" });
    // Reproduce Chromium delivering the layout scroll's end after the new input
    // reaches the scrollport, but before the native PageUp has moved it.
    await transcript.evaluate((node) => {
      node.addEventListener("keydown", () => node.dispatchEvent(new Event("scrollend")), {
        once: true,
      });
    });
    await page.keyboard.press("PageUp");
    await expect(revealed).toHaveCount(1);
    expect(await transcript.evaluate((node) => node.getAnimations().length)).toBe(0);
    expect(await contrast()).toBeGreaterThan(12);
    await idle();
    expect(await contrast()).toBeLessThanOrEqual(1);
    await page.emulateMedia({ forcedColors: "active" });
    await expect.poll(contrast).toBeGreaterThan(12);
    expect((await geometry()).gutter).toBe(2 * (16 + 5));
    await screenshot("forced-colors-idle");

    const background = () =>
      transcript.evaluate((node) => getComputedStyle(node).getPropertyValue("--background"));
    const light = await background();
    await page.emulateMedia({
      forcedColors: "none",
      reducedMotion: "no-preference",
      colorScheme: "dark",
    });
    await expect.poll(background).not.toBe(light);
    await expect.poll(contrast).toBeLessThanOrEqual(1);
    await page.keyboard.press("PageUp");
    await expect.poll(contrast).toBeGreaterThan(12);
    await screenshot("dark-visible");
    await expect.poll(contrast).toBeLessThanOrEqual(1);
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
