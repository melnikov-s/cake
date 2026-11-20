import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repository = resolve(import.meta.dirname, "../..");

test("Cake Chat's native scrollbar reveals only at the gutter or during scrolling and drag", async ({}, testInfo) => {
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
    await expect(page.getByRole("combobox", { name: "Message Cake Chat" })).toBeVisible();
    const transcript = page.getByRole("region", { name: "Conversation", exact: true });
    const handle = page.getByRole("separator", { name: "Resize Workspace", exact: true });
    const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
    const jump = page.getByRole("button", { name: "Scroll to bottom", exact: true });
    const gap = () =>
      transcript.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    // Legend List mounts the region before its actual scrollport has been laid out.
    const height = () => transcript.evaluate((node) => node.clientHeight);
    await expect.poll(height).toBeGreaterThan(0);
    const viewportHeight = await height();
    const atBottom = () => expect.poll(gap).toBeLessThanOrEqual(1);
    const jumpToBottom = async () => {
      await jump.click();
      await atBottom();
      await expect(jump).toHaveCount(0);
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
    const expectThumb = async (visible: boolean) => {
      // Compare the painted thumb with the transparent strip alongside it so
      // this verifies actual native scrollbar painting, not just an attribute.
      await expect
        .poll(async () => {
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
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
              const context = canvas.getContext("2d")!;
              context.drawImage(bitmap, 0, 0);
              bitmap.close();
              const { data } = context.getImageData(0, 0, canvas.width, 1);
              const end = data.length - 4;
              return [0, 1, 2].some(
                (channel) => Math.abs(data[channel]! - data[end + channel]!) > 12,
              );
            },
            [...png],
          );
        })
        .toBe(visible);
    };

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
      const text = await transcript.locator('[data-slot="message-content"]').evaluate((node) => {
        const line = "Message line 90";
        const text = node.firstChild!;
        const offset = text.textContent!.indexOf(line);
        const range = document.createRange();
        range.setStart(text, offset);
        range.setEnd(text, offset + line.length);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      const edge = { x: rect.x + rect.width - 13, y: text.y };
      const label = paneOpen ? "workspace-open" : "workspace-closed";
      // The shell's inset chat surface stops 5px before the open Workspace.
      if (paneOpen) expect(pane!.x - (rect.x + rect.width)).toBeCloseTo(5, 0);
      await page.mouse.move(text.x, text.y);
      await expectThumb(false);
      const idleGeometry = await geometry();
      expect(idleGeometry.gutter).toBe(16 + 5); // Native hit area + transparent border.
      await page.screenshot({ path: testInfo.outputPath(`${label}-idle.png`) });
      // Hover over the track, not the thumb. No scroll input has occurred.
      await page.mouse.move(edge.x, edge.y);
      await page.waitForTimeout(750); // Edge hover doesn't expire while still over the track.
      await expectThumb(true);
      expect(await geometry()).toEqual(idleGeometry);
      await page.screenshot({ path: testInfo.outputPath(`${label}-edge.png`) });
      await page.mouse.move(text.x, text.y);
      await expectThumb(false);
      expect(await geometry()).toEqual(idleGeometry);

      await page.mouse.wheel(0, -1600);
      await expect.poll(gap).toBeGreaterThan(viewportHeight);
      await expectThumb(true);
      await expectThumb(false);
      await jumpToBottom();

      for (const inset of [6, 20]) {
        // Sample both sides of the native thumb, including the side nearest the divider.
        const point = await thumb(inset);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try {
          // Pressing the thumb alone shouldn't jump as a track click would.
          expect(await gap()).toBeLessThanOrEqual(1);
          await page.mouse.move(rect.x + rect.width - 30, point.y - 310, { steps: 8 });
          await expect.poll(gap).toBeGreaterThan(viewportHeight);
          // Hold outside the gutter, without moving, longer than the idle delay.
          await page.waitForTimeout(750);
          await expectThumb(true);
          if (paneOpen) {
            await expect(handle).toHaveAttribute("aria-valuenow", value!);
            await expect(page.locator("main.select-none")).toHaveCount(0);
          }
        } finally {
          await page.mouse.up();
        }
        await expectThumb(true); // Release outside the gutter starts a new idle delay.
        await expectThumb(false);
        if (paneOpen) expect(await workspace.boundingBox()).toEqual(pane);
        await jumpToBottom();
      }
    }

    await transcript.focus();
    await expect(transcript).toBeFocused();
    await page.keyboard.press("PageUp");
    await expect.poll(gap).toBeGreaterThan(0);
    await expectThumb(true);
    await expectThumb(false);
    await page.keyboard.press("End");
    await atBottom();
    await expect(transcript).toBeFocused();

    // Explicitly returning to the end re-enables following across viewport changes.
    await page.setViewportSize({ width: 1280, height: 680 });
    await expect.poll(height).toBeLessThan(viewportHeight);
    await atBottom();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
