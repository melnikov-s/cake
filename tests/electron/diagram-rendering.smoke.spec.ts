import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");

for (const { theme, standalone } of (["light", "dark"] as const).flatMap((theme) => [
  { theme, standalone: false },
  { theme, standalone: true },
])) {
  test(`Pele diagrams resize, zoom, virtualize and fullscreen (${theme}, ${standalone ? "standalone" : "mixed response"})`, async () => {
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
    const diagramMarkdown = [
      "```mermaid",
      "graph TD",
      `%% ${"A detailed pipeline description. ".repeat(20)}`,
      "  A[Cake application] --> B[Pi agent engine]",
      "  B --> C[Renderer presentation] --> D[SVG output]",
      "  D --> E[Authored foreground] --> F[Named color]",
      "  classDef runtime fill:#fff2cc,stroke:#d6b656",
      "  class B runtime",
      "  style C fill:#d5e8d4,stroke:#82b366",
      "  style D fill:#17365d",
      "  style E fill:#fff2cc,color:#543800",
      "  style F fill:rebeccapurple",
      "```",
    ].join("\n");
    const assistantMarkdown = standalone
      ? diagramMarkdown
      : `Here is the pipeline:\n\n${diagramMarkdown}\n\nEach stage builds on the previous one.`;
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

      const assertNodeContrast = async () => {
        const colors = await diagram.evaluate((svg) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const context = canvas.getContext("2d")!;
          const luminance = (color: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = color;
            context.fillRect(0, 0, 1, 1);
            const channels = Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
            const linear = channels.map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
          };
          return ["A", "B", "C", "D", "E", "F"].map((id) => {
            const node = svg.querySelector(`.pele-node[data-id="${id}"]`)!;
            const background = getComputedStyle(node.querySelector("rect")!).fill;
            const foreground = getComputedStyle(node.querySelector(".pele-label")!).fill;
            const a = luminance(background);
            const b = luminance(foreground);
            return {
              id,
              background,
              foreground,
              contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
            };
          });
        });
        for (const color of colors)
          expect(color.contrast, JSON.stringify(color)).toBeGreaterThanOrEqual(4.5);
        expect(colors.find((color) => color.id === "B")!.background).toBe("rgb(255, 242, 204)");
        expect(colors.find((color) => color.id === "C")!.background).toBe("rgb(213, 232, 212)");
        expect(colors.find((color) => color.id === "E")!.foreground).toBe("rgb(84, 56, 0)");
      };
      await assertNodeContrast();

      // Hover exposes the outer response control, so hidden duplicates also fail.
      const message = page.locator('[data-slot="message"]').filter({ has: diagram });
      await message.hover();
      await expect(message.getByRole("button", { name: /View .*fullscreen/ })).toHaveCount(
        standalone ? 1 : 2,
      );
      await expect(message.getByRole("button", { name: "View response fullscreen" })).toHaveCount(
        standalone ? 0 : 1,
      );
      // Hidden windows cannot use the OS clipboard; capture only that boundary.
      await page.evaluate(() => {
        let copied = "";
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text: string) => {
              copied = text;
            },
            readText: async () => copied,
          },
        });
      });
      await message.getByRole("button", { name: "Copy code", exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe(diagramMarkdown.slice("```mermaid\n".length, -"\n```".length));

      const fitBox = await diagram.getAttribute("viewBox");
      await page.getByRole("button", { name: "Zoom in", exact: true }).click();
      await expect(diagram).not.toHaveAttribute("viewBox", fitBox!);
      const zoomedBox = await diagram.getAttribute("viewBox");
      await page.getByRole("button", { name: "Zoom out", exact: true }).click();
      await expect(diagram).not.toHaveAttribute("viewBox", zoomedBox!);
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
      await assertNodeContrast();
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

      const reader = page.getByRole("dialog", { name: "Cake" });
      if (!standalone) {
        await page.getByRole("button", { name: "View response fullscreen" }).click({ force: true });
        await expect(reader).toBeVisible();
      }

      const diagramBlock = (standalone ? message : reader).locator('[data-diagram="pele"]');
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
      if (!standalone) {
        await expect(reader).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(reader).toHaveCount(0);
      } else {
        await expect(message.getByRole("button", { name: /View .*fullscreen/ })).toHaveCount(1);
      }
    } finally {
      await application.close();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
}
