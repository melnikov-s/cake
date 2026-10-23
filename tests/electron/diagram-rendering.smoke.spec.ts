import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const theme of ["light", "dark"] as const) {
  test(`Pele diagrams resize, zoom, virtualize and stack above the reader (${theme})`, async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-diagram-rendering-smoke-"));
    const userData = join(temporaryRoot, "user-data");
    const project = join(temporaryRoot, "project");
    const cakeHome = join(temporaryRoot, "cake-home");
    const sessionId = "diagram-rendering-session";
    const sessionDirectory = cakeWorkspaceSessionDirectory(
      project,
      join(cakeHome, "pi", "sessions"),
    );
    const timestamp = new Date(0).toISOString();
    const assistantMarkdown = [
      "Here is the pipeline:",
      "",
      "```mermaid",
      "graph TD",
      "  A[Cake application] --> B[Pi agent engine]",
      "  B --> C[Renderer presentation] --> D[SVG output]",
      "```",
      "",
      "Each stage builds on the previous one. The surrounding response is intentionally long enough to offer Cake's response reader so the diagram can be verified inside both transcript and fullscreen surfaces. ".repeat(
        4,
      ),
    ].join("\n");
    await Promise.all([
      mkdir(userData, { recursive: true }),
      mkdir(project, { recursive: true }),
      mkdir(sessionDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(userData, "window-state.json"),
      windowState({ project, sessionId, theme }),
    );
    await mkdir(join(cakeHome, "state"), { recursive: true });
    await writeFile(
      join(cakeHome, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
        trustedProjectPaths: [],
      }),
    );
    await writeFile(
      join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        ...Array.from({ length: 60 }, (_, index) => ({
          type: "message",
          id: `earlier-${index}`,
          parentId: index ? `earlier-${index - 1}` : null,
          timestamp,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `Earlier discussion ${index}. ${"Context for the pipeline. ".repeat(20)}`,
              },
            ],
            timestamp: index,
          },
        })),
        {
          type: "message",
          id: "user-1",
          parentId: "earlier-59",
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Draw the pipeline" }],
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "assistant-1",
          parentId: "user-1",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: assistantMarkdown }],
            api: "anthropic-messages",
            provider: "anthropic",
            model: "fixture",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
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
      const diagram = page.locator("svg.pele").first();
      await expect(diagram).toBeVisible({ timeout: 20_000 });
      await expect(diagram).toHaveAttribute("tabindex", "0");

      const fitBox = await diagram.getAttribute("viewBox");
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(diagram).not.toHaveAttribute("viewBox", fitBox!);
      await page.getByRole("button", { name: "Reset zoom", exact: true }).click();
      await expect(diagram).toHaveAttribute("viewBox", fitBox!);
      await diagram.focus();
      await page.keyboard.press("+");
      await expect(diagram).not.toHaveAttribute("viewBox", fitBox!);
      await page.keyboard.press("0");
      await expect(diagram).toHaveAttribute("viewBox", fitBox!);

      const beforeTheme = await diagram.evaluate((svg) => {
        svg.setAttribute("data-retained", "yes");
        return getComputedStyle(svg).color;
      });
      await page.evaluate(
        (next) => {
          document.documentElement.dataset.theme = next;
        },
        theme === "dark" ? "light" : "dark",
      );
      await expect
        .poll(() => diagram.evaluate((svg) => getComputedStyle(svg).color))
        .not.toBe(beforeTheme);
      await expect(diagram).toHaveAttribute("data-retained", "yes");
      await page.evaluate((next) => {
        document.documentElement.dataset.theme = next;
      }, theme);

      const wideWidth = await page
        .locator('[data-diagram="pele"]')
        .first()
        .evaluate((element) => element.clientWidth);
      await page.setViewportSize({ width: 720, height: 900 });
      await expect(diagram).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('[data-diagram="pele"]')
            .first()
            .evaluate((element) => element.clientWidth),
        )
        .toBeLessThan(wideWidth);
      await expect(diagram).not.toHaveAttribute("data-retained", "yes");
      const fits = await page
        .locator('[data-diagram="pele"]')
        .first()
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
      expect(fits).toBe(true);
      await page.setViewportSize({ width: 1280, height: 900 });

      const transcript = page.locator(".transcript").first();
      await transcript.evaluate((element) => element.scrollTo(0, 0));
      await expect(diagram).toHaveCount(0);
      await transcript.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await expect(diagram).toBeVisible();
      await expect(diagram).toHaveAttribute("tabindex", "0");

      await page.getByRole("button", { name: "View response fullscreen" }).click({ force: true });
      const reader = page.getByRole("dialog", { name: "Cake" });
      await expect(reader).toBeVisible();

      const diagramBlock = reader.locator('[data-diagram="pele"]');
      await expect(diagramBlock.locator("svg.pele")).toBeVisible();
      await diagramBlock.getByRole("button", { name: "View diagram fullscreen" }).click();

      const overlay = page.getByRole("dialog", { name: "Diagram" });
      await expect(overlay).toBeVisible();
      await expect(
        overlay.locator("svg").filter({ hasText: "Renderer presentation" }),
      ).toBeVisible();

      // The overlay must actually paint above the reader, not behind it.
      const diagramIsTopmost = await overlay.evaluate((surface) => {
        const element = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
        return Boolean(element && surface.contains(element));
      });
      expect(diagramIsTopmost).toBe(true);

      await page.keyboard.press("Escape");
      await expect(overlay).toHaveCount(0);
      await expect(reader).toBeVisible();

      await page.keyboard.press("Escape");
      await expect(reader).toHaveCount(0);
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
