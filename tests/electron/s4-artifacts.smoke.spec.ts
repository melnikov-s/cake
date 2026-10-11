import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFile = promisify(execFileCallback);

test("opens the shared artifact popup and library and isolates HTML", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-s4-smoke-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  const cakeHome = join(temporaryRoot, "cake-home");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  await mkdir(join(cakeHome, "state"), { recursive: true });
  await writeFile(
    join(cakeHome, "state", "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      trustedProjectPaths: [],
    }),
  );
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
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
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1_600, height: 1_000 });
    const input = page.getByLabel("Message", { exact: true });
    await expect(input).toBeVisible({ timeout: 20_000 });
    const emptyControl = page.getByRole("button", { name: "0 artifacts" });
    const popup = page.getByRole("dialog", { name: "Artifacts", exact: true });
    await emptyControl.click();
    await expect(popup.getByText("No artifacts yet.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).not.toBeAttached();
    await expect(emptyControl).toBeFocused();
    await emptyControl.click();
    await input.click();
    await expect(popup).not.toBeAttached();
    await expect(input).toBeFocused();
    await input.pressSequentially("/cake-artifacts");
    await expect(input).toHaveValue("/cake-artifacts");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const artifactControl = page.getByRole("button", { name: "4 artifacts" });
    await expect(artifactControl).toBeVisible();
    await page.getByRole("button", { name: /Artifact examples presented/ }).click();
    await artifactControl.click();
    await expect(
      popup.getByRole("navigation", { name: "Artifact list" }).getByRole("button"),
    ).toHaveCount(4);
    await popup.getByRole("button", { name: /S4 table/ }).click();
    await expect(popup).not.toBeAttached();
    await expect(page.getByLabel("Search artifact library")).toBeVisible();
    const table = page.locator('[data-artifact-id="cake-s4-table"]');
    await expect(table).toBeVisible();
    await expect(
      table.locator('[data-slot="artifact-table"] tbody td').allTextContents(),
    ).resolves.toEqual(["", "Alpha", "2", "", "Beta", "1"]);
    await table.getByRole("button", { name: "Score" }).click();
    await expect(
      table.locator('[data-slot="artifact-table"] tbody td').allTextContents(),
    ).resolves.toEqual(["", "Beta", "1", "", "Alpha", "2"]);

    await application.evaluate(({ Menu }) => {
      const build = Menu.buildFromTemplate.bind(Menu);
      let nextAction = "Add annotation";
      Menu.buildFromTemplate = (template) => {
        const menu = build(template);
        menu.popup = (options) => {
          const item = menu.items.find((candidate) => candidate.label === nextAction);
          if (!item?.click) throw new Error(`Missing ${nextAction}`);
          nextAction = "Chat about this";
          item.click(item, options.window!, { triggeredByAccelerator: false });
          options.callback?.();
        };
        return menu;
      };
    });
    const rightClickSelection = async () => {
      await table.getByText("Alpha").evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
          }),
        );
      });
    };
    await rightClickSelection();
    const annotation = page.getByRole("dialog", { name: "Add annotation" });
    await expect(annotation).toBeVisible();
    await page.getByLabel("Annotation comment").fill("Review this artifact value");
    await annotation.getByRole("button", { name: "Add annotation" }).click();
    await expect(page.getByRole("button", { name: "View 1 annotation" })).toBeVisible();
    await artifactControl.click();
    await popup.getByRole("button", { name: /S4 table/ }).click();
    await expect(table).toBeVisible();
    await rightClickSelection();
    const sideChat = page.getByRole("complementary", { name: "Side chat" });
    await expect(sideChat).toBeVisible();
    await expect(sideChat.getByText("Alpha")).toBeVisible();
    const draftInput = sideChat.getByLabel("Message about selected text");
    await expect(draftInput).toBeFocused();
    await draftInput.pressSequentially("Why is Alpha here?");
    await expect(draftInput).toHaveValue("Why is Alpha here?");
    await expect(sideChat.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Close Side chat", exact: true }).click();

    await artifactControl.click();
    await popup.getByRole("button", { name: /S4 widget/ }).click();
    const widget = page.locator('[data-artifact-id="cake-s4-widget"]');
    await expect(widget.locator("iframe")).toBeVisible();
    await expect(widget.getByRole("button", { name: "Repair" })).not.toBeAttached();
    await widget.getByRole("button", { name: "View S4 widget fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "S4 widget", exact: true });
    await expect(fullscreen.locator("iframe")).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen S4 widget" }).click();
    await expect(fullscreen).not.toBeAttached();
    await page.getByRole("button", { name: /S4 diagram/ }).click();
    await expect(page.locator('[data-artifact-id="cake-s4-diagram"] iframe')).toBeVisible();
    await page.getByRole("button", { name: /Sandboxed HTML/ }).click();
    const html = page.locator('[data-artifact-id="cake-s4-html"] iframe');
    await expect(html).toHaveAttribute("sandbox", "");
    await expect(html).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(page.locator("body")).not.toContainText("compromised");
    await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
    await page.setViewportSize({ width: 700, height: 900 });
    await artifactControl.click();
    await expect(popup).toBeVisible();
    await expect(input).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popup).not.toBeAttached();
    await artifactControl.click();
    await popup.getByRole("button", { name: "Browse all artifacts" }).click();
    await page.getByLabel("Search artifact library").focus();
    await page.keyboard.press("Escape");
    await expect(input).toBeVisible();

    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(input).toBeEnabled();
    await input.fill("[Sandboxed HTML](cake://artifact/cake-s4-html@r1)");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const referencePreview = page.locator(
      '[data-artifact-reference="cake://artifact/cake-s4-html@r1"]',
    );
    await expect(referencePreview).toHaveRole("link");
    await expect(referencePreview).toHaveText("Sandboxed HTML");
    await referencePreview.hover();
    await expect(referencePreview).toHaveAccessibleDescription("cake://artifact/cake-s4-html@r1");
    await expect(page.getByRole("tooltip")).toHaveText("cake://artifact/cake-s4-html@r1");
    await referencePreview.click();
    await expect(page.getByLabel("Search artifact library")).toBeVisible();
    await page.getByRole("button", { name: "Link to this session", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unlink", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pin r1", exact: true }).click();
    await page.setViewportSize({ width: 1_600, height: 1_000 });
    await page.getByRole("button", { name: "Close all artifacts", exact: true }).click();
    const linkedControl = page.getByRole("button", { name: "1 artifacts" });
    await linkedControl.click();
    await popup.getByRole("button", { name: /Sandboxed HTML/ }).click();
    await expect(html).toBeVisible();
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => undefined },
      }),
    );
    await page.getByRole("button", { name: "Copy readable path", exact: true }).click();
    await expect(page.getByText("Copied", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /S4 table/ }).click();
    await page.getByRole("button", { name: "Link to this session", exact: true }).click();
    await page.getByLabel("Selected artifact revision").selectOption("1");
    await expect(page.getByText("Revision 1 of 2", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Restore as new latest", exact: true }).click();
    const restoreDialog = page.getByRole("alertdialog");
    await expect(restoreDialog).toContainText("Restore revision 1?");
    await restoreDialog.getByRole("button", { name: "Restore as new latest", exact: true }).click();
    await expect(page.getByText("Revision 3 of 3", { exact: false })).toBeVisible();
  } finally {
    await application?.close();
    await execFile("chmod", ["-R", "u+w", temporaryRoot]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
