import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Workspace divider releases normal and interrupted drags without leaving resize mode active", async () => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "cake-workspace-resize-"));
  const project = join(directory, "project");
  const cakeHome = join(directory, "cake-home");
  const userData = join(directory, "user-data");
  await Promise.all([
    mkdir(project),
    mkdir(userData),
    mkdir(join(cakeHome, "state"), { recursive: true }),
  ]);
  await writeFile(join(userData, "window-state.json"), windowState({ project }));
  const timestamp = new Date(0).toISOString();
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        { path: project, name: "Resize fixture", addedAt: timestamp, lastOpenedAt: timestamp },
      ],
    }),
  );
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900),
    );
    await page
      .getByRole("button", { name: "Open Project Chat for Resize fixture", exact: true })
      .click();
    const handle = page.getByRole("separator", { name: "Resize Workspace", exact: true });
    const shell = page.locator("main").filter({ has: handle });
    const workspace = page.getByRole("complementary", { name: "Workspace", exact: true });
    const width = () => handle.evaluate((node) => Number(node.getAttribute("aria-valuenow")));
    const beginDrag = async () => {
      await expect(handle).toBeVisible();
      const box = (await handle.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + 220;
      await handle.evaluate((node) => {
        node.addEventListener(
          "pointerdown",
          (event) => {
            node.setAttribute("data-test-pointer", String((event as PointerEvent).pointerId));
          },
          { once: true },
        );
      });
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 20, y);
      await expect(shell).toHaveClass(/select-none/);
      return { x, y };
    };
    const expectEnded = async () => {
      await expect(shell).not.toHaveClass(/select-none/);
      const committed = await width();
      expect(
        await workspace.evaluate((node) => Math.round(node.getBoundingClientRect().width)),
      ).toBe(committed);
      await page.mouse.up();
      await page.mouse.move(600, 400);
      await expect(handle).toHaveAttribute("aria-valuenow", String(committed));
      await expect(shell).not.toHaveClass(/select-none/);
    };

    for (const tab of ["To-dos", "Sessions"]) {
      await workspace.getByRole("button", { name: new RegExp(`^${tab}`) }).click();
      const initial = await width();
      const { x, y } = await beginDrag();
      // Capture must deliver a release well away from the divider, not merely
      // a synthetic pointerup dispatched directly to the handle.
      await page.mouse.move(x - 40, y + 80);
      await page.mouse.up();
      await expectEnded();
      await expect(handle).toHaveAttribute("aria-valuenow", String(Math.min(initial + 40, 520)));
    }

    await beginDrag();
    await handle.evaluate((node) => {
      const pointerId = Number(node.getAttribute("data-test-pointer"));
      if (!node.hasPointerCapture(pointerId))
        throw new Error("Drag did not acquire native capture");
      node.releasePointerCapture(pointerId);
    });
    // Chromium dispatches the real lostpointercapture at the next pointer event.
    await page.mouse.move(600, 400);
    await expectEnded();

    await beginDrag();
    // Exercise the interruption signal without showing/focusing a native window.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expectEnded();

    await beginDrag();
    await page.evaluate(() => {
      const node = document.querySelector('[aria-label="Resize Workspace"]')!;
      window.dispatchEvent(
        new PointerEvent("pointercancel", {
          pointerId: Number(node.getAttribute("data-test-pointer")),
        }),
      );
    });
    await expectEnded();

    await beginDrag();
    await page.getByRole("button", { name: "Close Workspace", exact: true }).evaluate((node) => {
      (node as HTMLButtonElement).click();
    });
    await expect(handle).toHaveCount(0);
    // Hiding just the handle must clear the surviving shell's interaction state.
    await expect(page.locator("main.select-none")).toHaveCount(0);
    await page.mouse.up();
    await page.getByRole("button", { name: "Open Workspace", exact: true }).click();
    await beginDrag();
    await page.mouse.up();
    await expectEnded();
    expect(errors).toEqual([]);
  } finally {
    await application.close();
    await rm(directory, { recursive: true, force: true });
  }
});
