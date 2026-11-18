import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { seedCakeChatHistory } from "./durable-chat-fixture";

const repository = resolve(import.meta.dirname, "../..");

test("Cake Chat's native thumb drags across its width without resizing Workspace", async () => {
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

    for (const paneOpen of [true, false]) {
      if (paneOpen) await expect(handle).toBeVisible();
      else {
        await page.getByRole("button", { name: "Close Workspace", exact: true }).click();
        await expect(handle).toHaveCount(0);
      }
      const pane = paneOpen ? await workspace.boundingBox() : null;
      const value = paneOpen ? await handle.getAttribute("aria-valuenow") : null;
      await atBottom();
      for (const inset of [6, 20]) {
        // Sample both sides of the thumb, 14px apart. With Workspace open,
        // its divider sits at rect.right and the first sample is next to its hit area.
        const point = await transcript.evaluate((node, inset) => {
          const rect = node.getBoundingClientRect();
          const thumbHeight = Math.max(24, node.clientHeight ** 2 / node.scrollHeight);
          return { x: rect.right - inset, y: rect.bottom - thumbHeight / 2 };
        }, inset);
        if (paneOpen) expect(Math.abs(pane!.x - (point.x + inset))).toBeLessThanOrEqual(1);
        await page.mouse.move(point.x, point.y);
        await page.mouse.down();
        try {
          // Pressing the thumb alone shouldn't jump as a track click would.
          expect(await gap()).toBeLessThanOrEqual(1);
          await page.mouse.move(point.x - 8, point.y - 310, { steps: 8 });
          await expect.poll(gap).toBeGreaterThan(viewportHeight);
          if (paneOpen) {
            await expect(handle).toHaveAttribute("aria-valuenow", value!);
            await expect(page.locator("main.select-none")).toHaveCount(0);
          }
        } finally {
          await page.mouse.up();
        }
        if (paneOpen) expect(await workspace.boundingBox()).toEqual(pane);
        await jumpToBottom();
      }
    }

    await transcript.hover({ position: { x: 60, y: 150 } });
    await page.mouse.wheel(0, -1600);
    await expect.poll(gap).toBeGreaterThan(viewportHeight);
    await jumpToBottom();

    // Explicitly returning to the end re-enables following across viewport changes.
    await page.setViewportSize({ width: 1280, height: 680 });
    await expect.poll(height).toBeLessThan(viewportHeight);
    await atBottom();
  } finally {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
