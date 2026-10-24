import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`old widget headers remain identifiable when collapsed and reopened (${theme})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-widget-revisions-"));
    const paths = {
      cakeHome: join(root, "cake-home"),
      project: join(root, "project"),
      userData: join(root, "user-data"),
    };
    const scenario = findVisualCaptureScenario("inline-artifact-revisions")!;
    await scenario.seed(paths, theme);
    const app = await electron.launch({
      args: [repositoryRoot],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: paths.userData,
        CAKE_HOME: paths.cakeHome,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    try {
      const page = await app.firstWindow();
      await scenario.prepare(page, "default", app);
      const disclosures = page.locator('[data-slot="artifact-disclosure"]');
      const old = disclosures.filter({ hasText: "Old version" });
      const oldToggle = old.getByRole("button", {
        name: "Inline visualization Expand Old version",
        exact: true,
      });
      const currentToggle = disclosures.getByRole("button", {
        name: "Inline visualization Expand",
        exact: true,
      });
      await expect(oldToggle).toHaveAttribute("aria-expanded", "false");
      await expect(currentToggle).toHaveAttribute("aria-expanded", "false");
      await oldToggle.focus();
      await oldToggle.press("Enter");
      await expect(old.getByText("Old version")).toBeVisible();
      const frame = old.locator("iframe").contentFrame();
      await expect(frame.getByRole("heading", { name: "One artifact, two views" })).toBeVisible();
      await frame.getByRole("button", { name: "Explore detail" }).click();
      await expect(frame.getByRole("button", { name: "Hide detail" })).toBeVisible();
      await currentToggle.click();
      await expect(disclosures.locator('[data-artifact-id="inline-visual"]')).toHaveCount(2);
      await expect(disclosures.getByText("Old version")).toHaveCount(1);
      await expect(
        disclosures.getByRole("button", { name: "Inline visualization Collapse", exact: true }),
      ).toBeVisible();
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
