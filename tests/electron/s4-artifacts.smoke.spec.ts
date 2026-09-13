import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opens the artifact workspace, keeps requests inline, and isolates HTML", async () => {
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
  const launch = () =>
    electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: userData,
        CAKE_HOME: cakeHome,
      },
    });
  let application: ElectronApplication | undefined;

  try {
    application = await launch();
    const page = await application.firstWindow();
    await page.setViewportSize({ width: 1_600, height: 1_000 });
    await expect(page.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: "0 artifacts" })).not.toBeAttached();

    await page.getByLabel("Message").fill("/cake-artifacts");
    await page.getByRole("button", { name: "Send" }).click();

    const artifactControl = page.getByRole("button", { name: /\d+ artifacts/ });
    await expect(artifactControl).toHaveAccessibleName("4 artifacts");
    await expect(page.locator('[data-slot="artifact-workspace-layout"]')).toHaveAttribute(
      "data-presentation",
      "side-by-side",
    );
    await page.getByRole("button", { name: "All artifacts" }).click();
    await page.getByRole("button", { name: "S4 table" }).click();
    const table = page.locator('[data-artifact-id="cake-s4-table"]');
    await expect(table).toBeVisible();
    await expect(
      table.locator('[data-slot="artifact-table"] tbody td').allTextContents(),
    ).resolves.toEqual(["", "Alpha", "2", "", "Beta", "1"]);
    await table.getByRole("button", { name: "Score" }).click();
    await expect(
      table.locator('[data-slot="artifact-table"] tbody td').allTextContents(),
    ).resolves.toEqual(["", "Beta", "1", "", "Alpha", "2"]);

    await page.getByRole("button", { name: "All artifacts" }).click();
    await page.getByRole("button", { name: "S4 widget" }).click();
    const widget = page.locator('[data-artifact-id="cake-s4-widget"]');
    await expect(widget.locator("iframe")).toBeVisible();
    await widget.getByRole("button", { name: "Repair" }).click();
    const repairPrompt = widget.locator('[data-slot="inline-widget-repair-form"]');
    await expect(repairPrompt).toBeVisible();
    await expect(repairPrompt.getByLabel("What should be repaired?")).toBeFocused();
    await repairPrompt
      .getByLabel("What should be repaired?")
      .fill("Make the widget easier to scan on a narrow window.");
    await repairPrompt.getByRole("button", { name: "Submit" }).click();
    await expect(repairPrompt).not.toBeAttached();

    await page.getByRole("button", { name: "All artifacts" }).click();
    await page.getByRole("button", { name: "S4 diagram" }).click();
    await expect(page.locator('[data-artifact-id="cake-s4-diagram"] iframe')).toBeVisible();
    await page.getByRole("button", { name: "All artifacts" }).click();
    await page.getByRole("button", { name: "Sandboxed HTML" }).click();
    const html = page.locator('[data-artifact-id="cake-s4-html"] iframe');
    await expect(html).toHaveAttribute("sandbox", "");
    await expect(html).toHaveAttribute("srcdoc", /default-src 'none'/);
    await expect(page.locator("body")).not.toContainText("compromised");

    await artifactControl.click();
    const form = page.locator('[data-artifact-id="cake-s4-form"]');
    await expect(form).toBeVisible();
    await expect(form.getByRole("radio", { name: "Standard answer" })).toBeChecked();
    await form.getByRole("button", { name: "Skip" }).click({ noWaitAfter: true });
    await expect
      .poll(() => page.evaluate(() => document.body.innerText), { timeout: 10_000 })
      .toContain("Artifact request cancelled");

    await page.setViewportSize({ width: 700, height: 900 });
    await artifactControl.click();
    await expect(page.locator('[data-slot="artifact-workspace-layout"]')).toHaveAttribute(
      "data-presentation",
      "replacement",
    );
    await expect(page.getByRole("navigation", { name: "Session artifacts" })).toBeVisible();
    await expect
      .poll(async () => {
        const document = JSON.parse(
          await readFile(join(userData, "window-state.json"), "utf8"),
        ) as {
          version?: number;
          data?: {
            children?: {
              appShellStore?: {
                state?: {
                  selection?: { kind?: string; sessionId?: string };
                };
              };
            };
          };
        };
        const selection = document.data?.children?.appShellStore?.state?.selection;
        return Boolean(
          document.version === 10 && selection?.kind === "project-session" && selection.sessionId,
        );
      })
      .toBe(true);
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
