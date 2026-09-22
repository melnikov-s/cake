import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { sessionPluginsScenario } from "../../scripts/visual-capture/scenarios";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";
import type { ApplicationState } from "../../src/domain/application/application-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Session Plugins follow live Cake themes, own hide/show, and persist SDK state", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-session-plugins-"));
  const paths = {
    userData: join(temporaryRoot, "user-data"),
    cakeHome: join(temporaryRoot, "cake-home"),
    project: join(temporaryRoot, "project"),
  };
  await sessionPluginsScenario.seed(paths, "dark");
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: paths.userData,
      CAKE_HOME: paths.cakeHome,
    },
  });
  try {
    const page = await application.firstWindow();
    await sessionPluginsScenario.prepare(page, "default");
    const harness = await openRpcHarness(application, "session-plugins");
    const generated = page.frameLocator('iframe[title="Custom controls"]');
    const guide = page.getByRole("region", { name: "Guided steps", exact: true });
    const readState = () => callRpcHarness<ApplicationState>(harness, "getApplicationState");
    // Deliberately disagree with OS preference; then switch without remounting the frame.
    await page.emulateMedia({ colorScheme: "dark" });
    const frameIdentity = await page.locator('iframe[title="Custom controls"]').getAttribute("src");
    for (const theme of ["light", "dark", "light"] as const) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(generated.locator("html")).toHaveAttribute("data-theme", theme);
      const tokens = await page.evaluate(() => {
        const probe = document.createElement("div");
        document.body.append(probe);
        const result = Object.fromEntries(
          [
            "card",
            "card-foreground",
            "primary",
            "primary-foreground",
            "border",
            "muted",
            "ring",
          ].map((name) => {
            probe.style.color = `var(--${name})`;
            return [name, getComputedStyle(probe).color];
          }),
        );
        probe.remove();
        return result;
      });
      const body = generated.locator("body");
      await expect(body).toHaveCSS("background-color", tokens.card!);
      await expect(body).toHaveCSS("color", tokens["card-foreground"]!);
      await expect(guide.getByRole("button", { name: "Next", exact: true })).toHaveCSS(
        "background-color",
        tokens.primary!,
      );
      await expect(guide.getByRole("button", { name: "Previous" })).toBeDisabled();
      await expect(guide.getByRole("button", { name: "Previous" })).toHaveCSS("opacity", "0.45");
      const explain = generated.getByRole("button", { name: "Explain this" });
      await expect(explain).toHaveCSS("border-top-color", tokens.border!);
      await explain.hover();
      await expect(explain).toHaveCSS("background-color", tokens.muted!);
      await explain.focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(explain).toBeFocused();
      await expect(explain).toHaveCSS("outline-color", tokens.ring!);
      await expect(generated.getByRole("button", { name: "Unavailable" })).toBeDisabled();
      await expect(generated.getByRole("button", { name: "Unavailable" })).toHaveCSS(
        "opacity",
        "0.45",
      );
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "system";
    });
    await expect(generated.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expect(generated.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(page.locator('iframe[title="Custom controls"]')).toHaveAttribute(
      "src",
      frameIdentity!,
    );
    // SDK call crosses the real iframe -> host -> RPC -> storage -> renderer projection.
    await generated.getByRole("button", { name: "Explain this" }).click();
    await expect(generated.getByText("Selection clarified")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await readState()).sessionPlugins.find((plugin) => plugin.id === "generated")?.state,
      )
      .toEqual({ topic: "Selection clarified" });

    for (const title of ["Custom controls", "Draw guide", "Guided steps"]) {
      const hide = page.getByRole("button", { name: `Hide ${title}`, exact: true });
      await hide.focus();
      await hide.press("Enter");
      const show = page.getByRole("button", { name: `Show ${title}`, exact: true });
      await expect(show).toBeVisible();
      await expect(show).toBeEnabled();
      await expect(show).toHaveAttribute("aria-expanded", "false");
    }
    await callRpcHarness(harness, "setSessionPluginState", {
      sessionId: "visual-assistant-markdown-code",
      pluginId: "generated",
      state: { topic: "Updated while hidden" },
    });
    await expect(
      page.getByRole("button", { name: "Show Custom controls", exact: true }),
    ).toBeVisible();
    await expect(page.locator('iframe[title="Custom controls"]')).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Show Custom controls", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show Custom controls", exact: true }).click();
    await expect(generated.getByText("Updated while hidden")).toBeVisible();
    await page.getByRole("button", { name: "Show Guided steps", exact: true }).click();
    await callRpcHarness(harness, "setSessionPluginState", {
      sessionId: "visual-assistant-markdown-code",
      pluginId: "guided-steps",
      state: {
        label: "Second step",
        progress: { current: 2, total: 4 },
        actions: [
          { id: "previous", label: "Previous", message: "Revisit the previous step." },
          { id: "next", label: "Next", message: "Next step", primary: true },
        ],
      },
    });
    await expect(guide.getByText("2 / 4")).toBeVisible();
    await expect(guide.getByRole("button", { name: "Previous" })).toBeEnabled();
    const previous = guide.getByRole("button", { name: "Previous" });
    await previous.focus();
    await previous.press("Tab");
    await expect(guide.getByRole("button", { name: "Next", exact: true })).toBeFocused();
    await expect(guide.getByRole("button", { name: "Next", exact: true })).not.toHaveCSS(
      "box-shadow",
      "none",
    );
    const composer = page.getByLabel("Message", { exact: true });
    await composer.click();
    await expect(composer).toBeFocused();
    await composer.pressSequentially("Keep ordinary chat available");
    await expect(composer).toHaveValue("Keep ordinary chat available");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.fill("");
    await guide.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
      page.locator('[data-slot="message-content"]').filter({ hasText: "Next step" }).last(),
    ).toBeVisible();
    await expect(guide.getByText("2 / 4")).toBeVisible();
    await callRpcHarness(harness, "deleteSessionPlugin", {
      sessionId: "visual-assistant-markdown-code",
      pluginId: "guided-steps",
    });
    await expect(guide).toHaveCount(0);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
