import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test } from "@playwright/test";
import { findVisualCaptureScenario } from "../../scripts/visual-capture/scenarios";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`inline links share visible styling and destination titles in ${theme} mode`, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-inline-links-"));
    const paths = {
      cakeHome: join(temporaryRoot, "cake-home"),
      project: join(temporaryRoot, "project"),
      userData: join(temporaryRoot, "user-data"),
    };
    const scenario = findVisualCaptureScenario("inline-links")!;
    await scenario.seed(paths, theme);
    const application = await electron.launch({
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
      const page = await application.firstWindow();
      // Replace only the OS boundary: real Markdown, Store, Client, RPC and URL validation run.
      await application.evaluate(({ shell }) => {
        const urls: string[] = [];
        Object.assign(globalThis, { cakeTestExternalUrls: urls });
        Object.defineProperty(shell, "openExternal", {
          configurable: true,
          value: async (url: string) => {
            urls.push(url);
          },
        });
      });
      await scenario.prepare(page, "default");
      const sessionLink = "cake://session/visual-assistant-markdown-code";
      // Session links lead with their relationship glyph, which names the link (b6cd0f2d), and
      // describe the label, the Session's title and the reference (5c284c46).
      const destinations: [name: string, href: string, description: string, glyph: string][] = [
        ...(
          [
            ["Collaboration requirements", "cake://artifact/visual-link-report"],
            ["the implementation", "src/main.ts#L12-L24"],
            ["the website", "https://example.com/docs"],
            ["HTTP documentation", "http://example.com/docs"],
          ] as const
        ).map(([name, href]): [string, string, string, string] => [
          name,
          href,
          href,
          'svg[aria-hidden="true"]',
        ]),
        [
          "User Session this session",
          sessionLink,
          `this session How should agents capture Cake UI changes? ${sessionLink}`,
          '[data-slot="session-purpose"][data-purpose="user"] svg',
        ],
      ];
      let linkColor: string | undefined;
      for (const [label, destination, description, glyph] of destinations) {
        const link = page.getByRole("link", { name: label, exact: true });
        await expect(link).toHaveAttribute("href", destination);
        await expect(link.locator(glyph)).toHaveCount(1);
        await expect(link.locator(glyph)).toBeVisible();
        await expect(link).toHaveAccessibleDescription(description);
        // A settling transcript scroll dismisses a pending tooltip by design and can move the
        // link out from under the pointer; re-hover as a reader would.
        await expect(async () => {
          await page.mouse.move(1, 1);
          await link.hover();
          await expect(page.getByRole("tooltip")).toHaveText(description, { timeout: 1_500 });
          expect(await link.evaluate((element) => element.matches(":hover"))).toBe(true);
        }).toPass({ timeout: 15_000 });
        const presentation = await link.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            color: style.color,
            surroundingColor: getComputedStyle(element.parentElement!).color,
            weight: style.fontWeight,
            decoration: style.textDecorationLine,
            thickness: style.textDecorationThickness,
            display: style.display,
          };
        });
        if (destination === sessionLink) {
          // Session links render as named pills rather than underlined prose (5c284c46).
          expect(presentation.decoration).toBe("none");
          continue;
        }
        linkColor ??= presentation.color;
        expect(presentation.color).toBe(linkColor);
        expect(presentation.color).toBe(presentation.surroundingColor);
        expect(presentation.weight).toBe("600");
        expect(presentation.decoration).toBe("underline");
        expect(presentation.thickness).toBe("2px");
        expect(presentation.display).toBe("inline");
      }
      await page.mouse.move(1, 1);
      await expect(page.getByRole("tooltip")).not.toBeAttached();
      const artifact = page.getByRole("link", { name: "Collaboration requirements", exact: true });
      const implementation = page.getByRole("link", { name: "the implementation", exact: true });
      await implementation.focus();
      await expect(
        page.getByRole("link", { name: "the implementation", exact: true }),
      ).toBeFocused();
      await expect(page.getByRole("tooltip")).toHaveText("src/main.ts#L12-L24");
      await page.keyboard.press("Shift+Tab");
      await expect(artifact).toBeFocused();
      await expect(page.getByRole("tooltip")).toHaveText("cake://artifact/visual-link-report");
      await artifact.press("Escape");
      await expect(artifact).toBeFocused();
      await expect(page.getByRole("tooltip")).not.toBeAttached();
      for (const label of ["the website", "HTTP documentation"]) {
        const website = page.getByRole("link", { name: label, exact: true });
        await website.focus();
        await expect(page.getByRole("tooltip")).toHaveText(
          (await website.getAttribute("href")) ?? "",
        );
        if (label === "the website") await website.press("Enter");
        else await website.click();
        await expect(page.getByRole("tooltip")).not.toBeAttached();
      }
      await expect
        .poll(() =>
          application.evaluate(
            () =>
              (globalThis as typeof globalThis & { cakeTestExternalUrls: string[] })
                .cakeTestExternalUrls,
          ),
        )
        .toEqual(["https://example.com/docs", "http://example.com/docs"]);
      await expect(
        page.getByRole("link", { name: "User Session this session", exact: true }),
      ).toBeVisible();
      await artifact.press("Enter");
      await expect(page.getByRole("tooltip")).not.toBeAttached();
      await expect(
        page.getByRole("complementary", { name: "Collaboration requirements", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Collaboration requirements", exact: true }).first(),
      ).toBeVisible();
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
