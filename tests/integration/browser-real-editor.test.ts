import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { beforeAll, it } from "vitest";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

beforeAll(async () => {
  await promisify(execFile)(process.execPath, ["scripts/build-server.mjs"]);
  await promisify(execFile)(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "build", "--config", "vite.browser.config.ts"],
    { maxBuffer: 4 * 1024 * 1024 },
  );
}, 60_000);

// Homebrew's installed code-server is a host qualification, not a CI dependency.
// Linux/other hosts skip rather than substituting a fake upstream as parity proof.
it.skipIf(!existsSync("/opt/homebrew/bin/code-server"))(
  "qualifies installed code-server against production browser RPC and isolated editor",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-real-browser-editor-"));
    const home = join(root, "home");
    const project = join(root, "project");
    const sessionId = "00000000-0000-4000-8000-000000000001";
    const sessions = cakeWorkspaceSessionDirectory(project, join(home, "pi", "sessions"));
    await Promise.all(
      [project, join(home, "state"), sessions].map((path) => mkdir(path, { recursive: true })),
    );
    await writeFile(
      join(project, "qualification.ts"),
      "export const original = 42;\n" +
        Array.from({ length: 180 }, (_, line) => `// qualification line ${line + 2}\n`).join(""),
    );
    const timestamp = new Date(0).toISOString();
    await writeFile(
      join(home, "state", "application.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [
          {
            path: project,
            name: "Editor qualification",
            addedAt: timestamp,
            lastOpenedAt: timestamp,
          },
        ],
        trustedProjectPaths: [project],
        vscodeServerPath: "/opt/homebrew/bin/code-server",
      }),
    );
    await writeFile(
      join(sessions, `1970-01-01T00-00-00-000Z_${sessionId}.jsonl`),
      [
        { type: "session", version: 3, id: sessionId, timestamp, cwd: project },
        {
          type: "message",
          id: "user",
          parentId: null,
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: "Qualify browser editor" }],
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "answer",
          parentId: "user",
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Open [qualification.ts](qualification.ts#L1)." }],
            api: "openai-completions",
            provider: "test",
            model: "test",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 0,
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const backend = spawn(process.execPath, [resolve("out/server/main.mjs")], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: root,
        CAKE_HOME: home,
        CAKE_SERVER_ENABLED: "true",
        CAKE_SERVER_BROWSER_ENABLED: "true",
        CAKE_SERVER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    backend.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<void>((done) => backend.once("exit", () => done()));
    const watchdog = setTimeout(() => backend.kill("SIGKILL"), 110_000);
    try {
      const origin = await new Promise<string>((done, fail) => {
        backend.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const match = /Cake browser chat at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
          if (match?.[1]) done(match[1]);
        });
        backend.once("exit", () => fail(new Error(output)));
        backend.once("error", fail);
      });
      const browser = await chromium.launch({ channel: "chromium-headless-shell" });
      try {
        const page = await browser.newPage();
        page.setDefaultTimeout(15_000);
        const diagnostics: string[] = [];
        let editorSockets = 0;
        page.on("pageerror", (error) => diagnostics.push(`pageerror ${error.message}`));
        page.on("console", (message) => {
          if (message.type() !== "error") return;
          const text = message.text();
          if (
            /Content Security Policy|Refused to|ServiceWorker|Extension host/i.test(text) &&
            !text.includes("/vsda/rust/web/vsda")
          )
            diagnostics.push(`console ${text}`);
        });
        page.on("requestfailed", (request) => {
          if (
            request.url().includes("/editor/") &&
            request.failure()?.errorText !== "net::ERR_ABORTED"
          )
            diagnostics.push(`requestfailed ${request.url()} ${request.failure()?.errorText}`);
        });
        page.on("websocket", (socket) => {
          if (socket.url().includes("/editor/")) {
            editorSockets++;
            socket.on("socketerror", (error) => diagnostics.push(`ws error ${String(error)}`));
          }
        });
        page.on("response", (response) => {
          if (response.url().includes("/editor/") && response.status() >= 400)
            diagnostics.push(`HTTP ${response.status()} ${response.url()}`);
        });
        await page.goto(origin);
        await page.locator(`[data-slot="sidebar"] [data-session-id="${sessionId}"]`).last().click();
        await expect(page.getByTitle(/^Open qualification\.ts.*in VS Code$/)).toBeVisible();
        await page.getByTitle(/^Open qualification\.ts.*in VS Code$/).click();
        const frame = page.locator('iframe[title="VS Code workspace"]');
        try {
          await expect(frame).toHaveAttribute("src", /\/editor\/\d+\/[a-f0-9]{64}\//, {
            timeout: 30_000,
          });
        } catch (error) {
          throw new Error(
            `${String(error)}\nUI: ${await page.locator("body").innerText()}\nDiagnostics: ${diagnostics.join(" | ")}\nBackend: ${output}`,
            { cause: error },
          );
        }
        const src = await frame.getAttribute("src");
        if (!src) throw new Error("Missing leased editor URL");
        expect(new URL(src).origin).not.toBe(origin.slice(0, -1));
        expect((await page.request.get(new URL(new URL(src).pathname, origin).href)).status()).toBe(
          404,
        );
        expect((await page.request.get(new URL("/rpc", src).href)).status()).toBe(403);
        const editor = frame.contentFrame();
        await expect(editor.locator(".monaco-workbench")).toBeVisible({ timeout: 30_000 });
        await expect(editor.locator(".tab.active")).toContainText("qualification.ts", {
          timeout: 20_000,
        });
        await expect(editor.locator(".view-lines").first()).toContainText("original");
        const trust = editor.locator(".monaco-dialog-modal-block");
        if (await trust.isVisible())
          await trust.getByRole("button", { name: /Yes, I trust the authors/ }).click();
        await editor.locator(".view-lines").first().click();
        await page.keyboard.press("ControlOrMeta+End");
        await page.keyboard.type("\nexport const savedInBrowser = true;\n");
        await page.keyboard.press("ControlOrMeta+s");
        await expect
          .poll(() => readFile(join(project, "qualification.ts"), "utf8"))
          .toContain("savedInBrowser");
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
        await expect
          .poll(
            () =>
              editor
                .locator(".monaco-workbench")
                .evaluate((node) => node.classList.contains("vs-dark")),
            { timeout: 15_000 },
          )
          .toBe(true);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "light";
        });
        await expect
          .poll(
            () =>
              editor.locator(".monaco-workbench").evaluate((node) => node.classList.contains("vs")),
            { timeout: 15_000 },
          )
          .toBe(true);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
        await expect
          .poll(
            () =>
              editor
                .locator(".monaco-workbench")
                .evaluate((node) => node.classList.contains("vs-dark")),
            { timeout: 15_000 },
          )
          .toBe(true);
        await editor.locator(".view-lines").first().click();
        await page.keyboard.press("ControlOrMeta+Home");
        await page.keyboard.press("Shift+ArrowRight");
        const reveal = page
          .locator('[aria-label="Editor selections"]')
          .getByRole("button", { name: /Reveal qualification\.ts:1:1/ });
        await expect(reveal).toBeVisible();
        const slider = editor.locator(".editor-instance .scrollbar.vertical .slider").first();
        const bounds = await slider.boundingBox();
        if (!bounds) throw new Error("VS Code scrollbar missing");
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 450, { steps: 8 });
        await page.mouse.up();
        const visibleFirstLine = () =>
          editor.locator(".editor-instance .view-lines .view-line").first().innerText();
        await expect.poll(visibleFirstLine).toMatch(/qualification\s+line\s+1[0-9][0-9]/);
        await reveal.click();
        await expect.poll(visibleFirstLine).toContain("original");
        await editor.locator("body").evaluate(() => location.reload());
        try {
          await expect(editor.locator(".monaco-workbench")).toBeVisible({ timeout: 30_000 });
          await editor.getByRole("treeitem", { name: "qualification.ts" }).dblclick();
          await expect(editor.locator(".view-lines").first()).toContainText("savedInBrowser", {
            timeout: 20_000,
          });
        } catch (error) {
          throw new Error(
            `${String(error)}\nUI: ${await page.locator("body").innerText()}\nFrame count: ${await frame.count()}\nFrame body: ${await editor
              .locator("body")
              .innerText()
              .catch(
                () => "unavailable",
              )}\nLeased URL status: ${(await page.request.get(src)).status()}\nDiagnostics: ${diagnostics.join(" | ")}`,
            { cause: error },
          );
        }
        await expect(editor.locator(".monaco-workbench")).toHaveClass(/vs-dark/);
        expect(editorSockets).toBeGreaterThanOrEqual(2);
        // The Homebrew build lacks optional VSDA assets; update/check is deliberately
        // outside the leased workbench. No other failed editor route or CSP error is expected.
        const unexpected = diagnostics.filter(
          (error) => !error.includes("/vsda/rust/web/vsda") && !error.includes("/update/check"),
        );
        if (unexpected.length)
          throw new Error(`Unexpected code-server responses: ${unexpected.join("\n")}`);
        await page.getByRole("button", { name: "Back to agent" }).first().click();
        await expect(frame).toHaveCount(0);
        await expect.poll(async () => (await page.request.get(src)).status()).toBe(403);
      } finally {
        await browser.close();
      }
    } finally {
      clearTimeout(watchdog);
      if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGTERM");
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
