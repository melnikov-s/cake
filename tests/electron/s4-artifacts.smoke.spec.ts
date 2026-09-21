import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const execFile = promisify(execFileCallback);

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
    const artifactWorkspace = page.locator('[data-slot="artifact-workspace-layout"]');
    if ((await artifactWorkspace.getAttribute("data-presentation")) === "closed")
      await artifactControl.click();
    await expect(artifactWorkspace).toHaveAttribute("data-presentation", "side-by-side");
    const allArtifacts = page.getByRole("button", { name: "All artifacts" });
    if (await allArtifacts.isVisible()) await allArtifacts.click();
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
    await expect(widget.getByRole("button", { name: "Repair" })).not.toBeAttached();
    await expect(page.getByRole("button", { name: "Previous artifact" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Next artifact" })).toBeVisible();
    await widget.getByRole("button", { name: "View S4 widget fullscreen" }).click();
    const fullscreen = page.getByRole("dialog", { name: "S4 widget" });
    await expect(fullscreen.locator("iframe")).toBeVisible();
    await fullscreen.getByRole("button", { name: "Exit fullscreen S4 widget" }).click();
    await expect(fullscreen).not.toBeAttached();

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
    await expect(page.getByRole("img", { name: "Waiting for your answer" })).toBeVisible();

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

    await artifactControl.click();
    await page.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(page.getByLabel("Message")).toBeEnabled();
    await page.getByLabel("Message").fill("[Sandboxed HTML](cake://artifact/cake-s4-html@r1)");
    await page.getByRole("button", { name: "Send" }).click();
    const referencePreview = page.locator(
      '[data-artifact-reference="cake://artifact/cake-s4-html@r1"]',
    );
    await expect(
      referencePreview.getByRole("button", { name: "Link to this session" }),
    ).toBeVisible();
    await referencePreview.getByRole("button", { name: "Link to this session" }).click();
    await expect(referencePreview).toContainText("Linked");

    const linkedArtifactControl = page.getByRole("button", { name: "1 artifacts" });
    await expect(linkedArtifactControl).toBeVisible();
    if ((await artifactWorkspace.getAttribute("data-presentation")) === "closed")
      await linkedArtifactControl.click();
    const linkedArtifactNavigation = page.getByRole("navigation", { name: "Session artifacts" });
    if (await linkedArtifactNavigation.isVisible())
      await linkedArtifactNavigation.getByRole("button", { name: "Sandboxed HTML" }).click();
    const copyReadablePath = page.getByRole("button", { name: "Copy readable path" });
    await copyReadablePath.click();
    await expect(copyReadablePath).toBeEnabled();
    await expect(
      page.getByText("Could not materialize artifact", { exact: false }),
    ).not.toBeAttached();

    await page.getByRole("button", { name: "Open in Library" }).click();
    await expect(page.locator('[data-slot="workspace-header"]')).toContainText("Artifact Library");
    await expect(page.getByLabel("Search artifact library")).toBeVisible();
    await expect(page.locator('[data-artifact-id="cake-s4-html"] iframe')).toBeVisible();

    await page.getByRole("button", { name: /S4 table/ }).click();
    await page.getByRole("button", { name: "Link to this session" }).click();
    await page.getByLabel("Selected artifact revision").selectOption("1");
    await expect(page.getByText("Revision 1 of 2", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Restore as new latest" }).click();
    const restoreDialog = page.getByRole("alertdialog");
    await expect(restoreDialog).toContainText("Restore revision 1?");
    await restoreDialog.getByRole("button", { name: "Restore as new latest" }).click();
    await expect(page.getByText("Revision 3 of 3", { exact: false })).toBeVisible();
  } finally {
    await application?.close();
    await execFile("chmod", ["-R", "u+w", temporaryRoot]);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
