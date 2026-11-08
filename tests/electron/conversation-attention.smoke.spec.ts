import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { emptyProjectTodos } from "../../src/contracts/projects/project-todos";
import { seedCakeChatHistory } from "./durable-chat-fixture";
import { store, windowStateDocument } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");

for (const theme of ["dark", "light"] as const) {
  test(`own-chat attention pills: X, activation and preserved draft (${theme})`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cake-attention-pills-"));
    const paths = {
      cakeHome: join(directory, "cake"),
      project: join(directory, "project"),
      userData: join(directory, "user-data"),
    };
    const file = join(paths.cakeHome, "state", "application.json");
    const items = [
      {
        id: "00000000-0000-4000-8000-000000000011",
        title: "Startup investigation",
        attentionReason: "Review the startup findings before deciding the next step",
      },
      {
        id: "00000000-0000-4000-8000-000000000012",
        title: "Choose navigation",
        attentionReason: "Which navigation approach should we use?",
      },
    ].map((item) => ({
      ...item,
      description: "Findings ready",
      status: "",
      revision: 0,
      state: "open",
      needsAttention: true,
      associations: [],
    }));
    await mkdir(join(paths.cakeHome, "state"), { recursive: true });
    await mkdir(paths.userData, { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 10,
        data: { ...defaultApplicationState(), cakeChatTodos: { ...emptyProjectTodos(), items } },
      }),
    );
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowStateDocument({ settingsStore: store({}, { appearance: store({ theme }) }) }),
    );
    await seedCakeChatHistory(
      paths.cakeHome,
      "Let’s keep the launch decisions here while the sessions work.",
    );
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width: 1280, height: 800 });
      const composer = page.getByRole("combobox", { name: "Message Cake Chat" });
      if (!(await composer.isVisible()))
        await page
          .getByRole("button", { name: /^(Open )?Cake Chat$/ })
          .first()
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(composer).toBeVisible();
      await composer.fill("Keep this unsent draft");
      const queue = page
        .locator(".workbench-composer")
        .getByRole("region", { name: "Needs attention" });
      await expect(queue).toBeVisible();
      await expect(queue.getByRole("button")).toHaveCount(4);
      await expect(queue.getByText("Review", { exact: true })).toHaveCount(0);
      await expect(queue.getByText("This chat’s to-dos")).toHaveCount(0);
      const bounds = await queue.boundingBox();
      const inputBounds = await composer.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThan(inputBounds!.y);
      for (const button of await queue.getByRole("button").all()) {
        const size = await button.boundingBox();
        expect(size!.height).toBeGreaterThanOrEqual(28);
      }
      await composer.click();
      await page.mouse.move(900, 450);
      await expect(page.locator('[data-slot="project-rail"]')).toHaveCSS("width", "54px");
      await mkdir(join(repository, ".visual-captures"), { recursive: true });
      await page.screenshot({
        path: join(repository, ".visual-captures", `attention-pills-${theme}.png`),
      });
      await queue.getByRole("button", { name: `Clear attention: ${items[1].title}` }).click();
      await expect(queue.getByRole("button")).toHaveCount(2);
      await expect(composer).toHaveValue("Keep this unsent draft");
      const open = queue.getByRole("button", { name: `Open attention: ${items[0].title}` });
      await open.focus();
      await open.press("Enter");
      await expect(queue).toHaveCount(0);
      await expect(composer).toHaveValue("Keep this unsent draft");
      await composer.click();
      await composer.pressSequentially(" plus typing");
      await expect(composer).toHaveValue("Keep this unsent draft plus typing");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      const saved = JSON.parse(await readFile(file, "utf8")).data.cakeChatTodos.items;
      expect(
        saved
          .slice(0, 2)
          .map((item: { needsAttention: boolean; state: string }) => [
            item.needsAttention,
            item.state,
          ]),
      ).toEqual([
        [false, "open"],
        [false, "open"],
      ]);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every((window) => !window.isVisible()),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
