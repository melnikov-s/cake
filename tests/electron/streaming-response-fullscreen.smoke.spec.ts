import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { windowState } from "../fixtures/window-state";

const repository = resolve(import.meta.dirname, "../..");
const partial = "Streaming fullscreen response. ".repeat(24);
const ending = "Final persisted content is still in the reader.";
const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

for (const surface of ["project", "global", "session"] as const) {
  test(`${surface} chat keeps keyboard and message-owned fullscreen open through stream persistence`, async () => {
    test.setTimeout(60_000);
    const temporary = await mkdtemp(join(tmpdir(), "cake-stream-fullscreen-"));
    const project = join(temporary, "project");
    const cakeHome = join(temporary, "cake-home");
    const agentDir = join(cakeHome, "pi");
    const userData = join(temporary, "user-data");
    const responses: ServerResponse[] = [];
    const server = createServer(async (request, response) => {
      // Consume the request before starting our explicitly controlled stream.
      await request.toArray();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      responses.push(response);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
    try {
      await Promise.all([
        mkdir(project),
        mkdir(agentDir, { recursive: true }),
        mkdir(join(cakeHome, "state"), { recursive: true }),
        mkdir(userData),
      ]);
      await writeFile(
        join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "fixture",
              api: "openai-completions",
              models: [
                {
                  id: "fixture",
                  name: "Fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 4096,
                },
              ],
            },
          },
        }),
      );
      const presetId = "00000000-0000-4000-8000-000000000001";
      await writeFile(
        join(cakeHome, "state", "application.json"),
        JSON.stringify({
          version: 7,
          data: {
            ...defaultApplicationState(),
            projects: [
              {
                path: project,
                name: "Fullscreen project",
                addedAt: new Date(0).toISOString(),
                lastOpenedAt: new Date(0).toISOString(),
              },
            ],
            trustedProjectPaths: [project],
            modelPresets: [
              {
                id: presetId,
                name: "Fixture",
                provider: "fixture",
                modelId: "fixture",
                thinkingLevel: "off",
                fastMode: false,
              },
            ],
            defaultModelPresetId: presetId,
          },
        }),
      );
      const session = SessionManager.create(
        project,
        cakeWorkspaceSessionDirectory(project, join(agentDir, "sessions")),
      );
      session.appendSessionInfo("Fullscreen session");
      session.appendModelChange("fixture", "fixture");
      session.appendMessage({ role: "user", content: "Earlier session input", timestamp: 1 });
      await writeFile(
        join(userData, "window-state.json"),
        windowState({ project, sessionId: session.getSessionId() }),
      );
      app = await electron.launch({
        args: [repository],
        cwd: repository,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: userData,
          CAKE_HOME: cakeHome,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      const page = await app.firstWindow();
      await expect(page.getByText("Earlier session input", { exact: true })).toBeVisible({
        timeout: 20_000,
      });
      if (surface === "session") {
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
        await page.getByRole("button", { name: /^Fullscreen session / }).click();
      }
      if (surface === "global")
        await page.getByRole("button", { name: "Cake Chat", exact: true }).click();
      if (surface === "project") {
        const id = `project-chat:${createHash("sha256").update(project).digest("hex")}`;
        await page
          .locator(
            `[data-slot="project-header"][data-session-id="${id}"] [data-slot="project-label"]`,
          )
          .click();
      }
      const composer = page.getByRole("combobox", {
        name:
          surface === "project"
            ? "Message Project Chat"
            : surface === "global"
              ? "Message Cake Chat"
              : "Message",
        exact: true,
      });
      const reader = page.getByRole("dialog", { name: "Cake", exact: true });
      const modifier = process.platform === "darwin" ? "Meta" : "Alt";
      for (const entry of ["keyboard", "message"] as const) {
        const count = responses.length;
        await composer.click();
        await composer.pressSequentially(`Explain fullscreen ${entry}`);
        await expect(composer).toBeFocused();
        await expect(composer).toHaveValue(`Explain fullscreen ${entry}`);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await composer.press("Enter");
        await expect.poll(() => responses.length).toBe(count + 1);
        const response = responses[count]!;
        response.write(chunk({ role: "assistant", content: partial }));
        const message = page
          .locator('[data-slot="message"]')
          .filter({ hasText: partial.trim() })
          .last();
        await expect(message).toBeVisible();
        const partId = () =>
          message.evaluate((node) => node.closest("[data-part-id]")?.getAttribute("data-part-id"));
        const liveId = await partId();
        expect(liveId).toBeTruthy();
        if (entry === "keyboard") {
          // No hovered message: exercise App's latest-response selection, not the message's local reader.
          await page.mouse.move(1, 1);
          expect(await page.locator('[data-slot="message"]:hover').count()).toBe(0);
          await page.keyboard.press(`${modifier}+Enter`);
        } else {
          await message.hover();
          await page.keyboard.press(`${modifier}+Enter`);
        }
        await expect(reader).toBeVisible();
        await expect(reader).toContainText(partial.trim());
        const readerNode = await reader.elementHandle();
        response.write(chunk({ content: ending }));
        response.end(chunk({}, "stop") + "data: [DONE]\n\n");
        // Wait for the real persisted projection, not merely a final streamed delta.
        await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
        await expect.poll(partId).not.toBe(liveId);
        await expect(reader).toBeVisible();
        await expect(reader).toContainText(ending);
        expect(await readerNode!.evaluate((node) => node.isConnected)).toBe(true);
        if (entry === "keyboard") await page.keyboard.press("Escape");
        else await reader.getByRole("button", { name: "Exit fullscreen Cake" }).click();
        await expect(reader).toHaveCount(0);
      }
      // Reopen a completed response; ordinary navigation still dismisses it.
      await page.mouse.move(1, 1);
      await page.keyboard.press(`${modifier}+Enter`);
      await expect(reader).toContainText(ending);
      await page.keyboard.press(process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft");
      await expect(reader).toHaveCount(0);
    } finally {
      for (const response of responses) response.end();
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
