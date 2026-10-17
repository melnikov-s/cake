import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { openRequestInspectorFixture } from "../../scripts/visual-capture/request-inspector-fixture";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const scope of ["global", "project-chat"] as const) {
  test(`${scope} context reveals literal sources and retained originals, including after reopen`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-context-outline-"));
    const cakeHome = join(root, "cake-home");
    const project = join(root, "project");
    const userData = join(root, "user-data");
    await Promise.all([
      mkdir(join(cakeHome, "state"), { recursive: true }),
      mkdir(join(cakeHome, "pi"), { recursive: true }),
      mkdir(project),
      mkdir(userData),
    ]);
    const closeProvider = await openRequestInspectorFixture({ cakeHome, project });
    const launch = () =>
      electron.launch({
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
    const projectId = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
    const openChat = async (page: Page) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      if (scope === "global") {
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      } else {
        await page
          .locator(
            `[data-slot="project-header"][data-session-id="${projectId}"] [data-slot="project-label"]`,
          )
          .click();
      }
      await expect(
        page.getByRole("combobox", {
          name: scope === "global" ? "Message Cake Chat" : "Message Project Chat",
          exact: true,
        }),
      ).toBeVisible();
    };
    let app = await launch();
    try {
      const page = await app.firstWindow();
      await openChat(page);
      const input = page.getByRole("combobox", {
        name: scope === "global" ? "Message Cake Chat" : "Message Project Chat",
        exact: true,
      });
      await input.click();
      await input.pressSequentially("Keep the interface quiet.");
      await expect(input).toHaveValue("Keep the interface quiet.");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByText("Request captured by the local inspection fixture.", { exact: true }),
      ).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await input.fill("Use familiar disclosure triangles.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        page.getByText("Request captured by the local inspection fixture.", { exact: true }),
      ).toHaveCount(2);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await input.fill("Unsent draft stays here");
      const trigger = page.getByRole("button", { name: "Browse context", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Context", exact: true });
      await expect(
        dialog.getByRole("button", { name: "Close context", exact: true }),
      ).toBeFocused();
      await dialog.getByRole("button", { name: "Cake Chat instructions", exact: true }).click();
      await expect(dialog).toContainText(
        "Prefer independent worktrees. Ask before merging changes.",
      );
      await dialog.getByRole("button", { name: "System prompt", exact: true }).click();
      await expect(dialog.locator("pre").first()).toBeVisible();
      const literal = await dialog.locator("pre").first().textContent();
      await dialog
        .locator("pre")
        .first()
        .evaluate((element) => {
          const selection = window.getSelection()!;
          const range = document.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        });
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(literal);
      await dialog.getByRole("button", { name: "System prompt", exact: true }).click();
      const memory = dialog.locator('[data-source-id="memory"]');
      await expect(memory.getByText("Depth 1").first()).toBeVisible();
      await memory.getByRole("button").nth(1).click();
      await expect(memory.locator("blockquote").first()).toContainText("Keep the interface quiet.");
      await expect(memory.getByText("Original").first()).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(input).toHaveValue("Unsent draft stays here");
      await input.click();
      await input.pressSequentially(" and remains editable");
      await expect(input).toHaveValue("Unsent draft stays here and remains editable");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();

      // Only this isolated fixture is reopened. Request captures are gone; Pi context is not.
      await app.close();
      app = await launch();
      const reopened = await app.firstWindow();
      await openChat(reopened);
      await reopened.getByRole("button", { name: "Browse context", exact: true }).click();
      const restored = reopened.getByRole("dialog", { name: "Context", exact: true });
      await expect(
        restored.getByRole("button", { name: "System prompt", exact: true }),
      ).toBeVisible();
      const restoredMemory = restored.locator('[data-source-id="memory"]');
      await restoredMemory.getByRole("button").nth(1).click();
      await expect(restoredMemory.locator("blockquote").first()).toContainText(
        "Keep the interface quiet.",
      );
    } finally {
      await app.close();
      await closeProvider();
      await rm(root, { recursive: true, force: true });
    }
  });
}
