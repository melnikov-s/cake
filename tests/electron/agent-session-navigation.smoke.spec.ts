import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { installLocalModelHttpGuard } from "./main-harness";
import { windowState } from "../fixtures/window-state";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const sourceId = "agent-navigation-source";
const timestamp = new Date(0).toISOString();

const chunk = (delta: object, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ id: "navigation", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

for (const { disabled, late } of [
  { disabled: false, late: false },
  { disabled: false, late: true },
  { disabled: true, late: false },
]) {
  const targetId = late ? "10000000-0000-4000-8000-000000000001" : "agent-navigation-target";
  test(
    disabled
      ? "user disables agent navigation, keeps manual navigation, and restores the permission after restart"
      : late
        ? "an exact-ID agent open recovers a durable session missing from the initial catalog"
        : "a normal Project Session agent opens an existing session through the Cake tool",
    async () => {
      test.setTimeout(60_000);
      const root = await mkdtemp(join(tmpdir(), "cake-agent-navigation-"));
      const cakeHome = join(root, "cake-home");
      const userData = join(root, "user-data");
      const project = join(root, "project");
      const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (part) => {
          body += part;
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
          const invocation = { command: "sessions.open", input: { sessionId: targetId } };
          const toolCall = requests.length === 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            chunk(
              toolCall
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: "open-target",
                        type: "function",
                        function: { name: "cake", arguments: JSON.stringify(invocation) },
                      },
                    ],
                  }
                : { content: "Navigation request finished." },
            ) +
              chunk({}, toolCall ? "tool_calls" : "stop") +
              "data: [DONE]\n\n",
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const sessionDirectory = cakeWorkspaceSessionDirectory(
        project,
        join(cakeHome, "pi", "sessions"),
      );
      await Promise.all(
        [userData, project, sessionDirectory, join(cakeHome, "state")].map((path) =>
          mkdir(path, { recursive: true }),
        ),
      );
      const transcript = (id: string, text: string) =>
        [
          { type: "session", version: 3, id, timestamp, cwd: project },
          {
            type: "model_change",
            id: "model",
            parentId: null,
            timestamp,
            provider: "navigation-provider",
            modelId: "fixture-model",
          },
          {
            type: "message",
            id: "user",
            parentId: "model",
            timestamp,
            message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n";
      await writeFile(
        join(sessionDirectory, `1970-01-01T00-00-00-000Z_${sourceId}.jsonl`),
        transcript(sourceId, "Source conversation."),
      );
      const persistTarget = () =>
        writeFile(
          join(sessionDirectory, `1970-01-01T00-00-00-000Z_${targetId}.jsonl`),
          transcript(targetId, "Target conversation."),
        );
      if (!late) await persistTarget();
      await writeFile(
        join(cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            "navigation-provider": {
              baseUrl: `${origin}/v1`,
              apiKey: "fixture",
              api: "openai-completions",
              models: [
                {
                  id: "fixture-model",
                  name: "Navigation fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 1024,
                },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(cakeHome, "state", "application.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            { path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          trustedProjectPaths: [project],
        }),
      );
      await writeFile(
        join(userData, "window-state.json"),
        windowState({ project, sessionId: sourceId }),
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
            PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
            PI_CODING_AGENT_SESSION_DIR: "",
          },
        });
      let application = await launch();
      try {
        await installLocalModelHttpGuard(application, origin);
        const page = await application.firstWindow();
        await expect(
          page.locator(".transcript").getByText("Source conversation.", { exact: true }),
        ).toBeVisible({ timeout: 20_000 });
        if (late) {
          await expect(page.locator(`.session-item[data-session-id="${sourceId}"]`)).toBeVisible();
          await expect(page.locator(`.session-item[data-session-id="${targetId}"]`)).toHaveCount(0);
          // No catalog event accompanies this durable transcript. The explicit UUID
          // must recover it through real RPC discovery, not a second full scan.
          await persistTarget();
        }
        if (disabled) {
          await page.getByRole("button", { name: "Open settings", exact: true }).click();
          await page.getByRole("button", { name: /^Agent Behavior and content$/ }).click();
          const toggle = page.getByRole("switch", { name: "Allow agent session navigation" });
          await expect(toggle).toBeChecked();
          await toggle.click();
          await expect(toggle).not.toBeChecked();
          await page.getByRole("button", { name: "Back to chat", exact: true }).click();
        }
        const composer = page.getByRole("combobox", { name: "Message", exact: true });
        await composer.click();
        await expect(composer).toBeFocused();
        await composer.pressSequentially("Open the target conversation.");
        await expect(composer).toHaveValue("Open the target conversation.");
        await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
        await composer.press("Enter");
        await expect.poll(() => requests.length).toBe(2);
        const results = requests[1]!
          .messages!.filter((message) => message.role === "tool")
          .map((message) => JSON.parse(String(message.content)));
        expect(results).toContainEqual(
          expect.objectContaining({
            ok: !disabled,
            command: "sessions.open",
            ...(disabled
              ? { error: expect.stringContaining("disabled") }
              : {
                  opened: expect.objectContaining({
                    sessionId: targetId,
                  }),
                }),
          }),
        );
        await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
          "data-session-id",
          disabled ? sourceId : targetId,
        );
        if (disabled) {
          await expect(
            page.locator(".transcript").getByText("Navigation request finished.", { exact: true }),
          ).toBeVisible();
          await page.locator(`.session-item[data-session-id="${targetId}"] .session-row`).click();
          await expect(
            page.locator(".transcript").getByText("Target conversation.", { exact: true }),
          ).toBeVisible();
          await expect
            .poll(
              async () =>
                JSON.parse(await readFile(join(userData, "window-state.json"), "utf8")).data
                  .children.settingsStore.children.agentNavigation.state.enabled,
            )
            .toBe(false);
          await application.close();
          application = await launch();
          await installLocalModelHttpGuard(application, origin);
          const restored = await application.firstWindow();
          await expect(
            restored.getByRole("button", { name: "Open settings", exact: true }),
          ).toBeVisible({ timeout: 20_000 });
          await restored.getByRole("button", { name: "Open settings", exact: true }).click();
          await restored.getByRole("button", { name: /^Agent Behavior and content$/ }).click();
          await expect(
            restored.getByRole("switch", { name: "Allow agent session navigation" }),
          ).not.toBeChecked();
        } else {
          await expect(
            page.locator(".transcript").getByText("Target conversation.", { exact: true }),
          ).toBeVisible();
        }
      } finally {
        await application.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
