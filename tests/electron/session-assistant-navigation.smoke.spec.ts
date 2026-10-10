import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";
import { installLocalModelHttpGuard } from "./main-harness";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const timestamp = new Date(0).toISOString();
const sourceId = "assistant-navigation-source";
const targetId = "assistant-navigation-archive";

function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: "navigation", object: "chat.completion.chunk", created: 0, model: "fixture-model", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

for (const scenario of ["migrated", "unavailable"] as const) {
  test(
    scenario === "migrated"
      ? "the session assistant opens a migrated archive and then resolves its source"
      : "a failed assistant open returns an error, restores the chat, and supports retry",
    async () => {
      test.setTimeout(60_000);
      const root = await mkdtemp(join(tmpdir(), "cake-assistant-navigation-"));
      const cakeHome = join(root, "cake-home");
      const userData = join(root, "user-data");
      const project = join(root, "project");
      const workingDirectory = join(root, "worktree");
      const activeRoot = join(cakeHome, "pi", "sessions");
      const resolvedRoot = join(cakeHome, "pi", "resolved-sessions");
      const oldActiveRoot = join(root, "old-pi", "sessions");
      const oldResolvedRoot = join(root, "old-pi", "resolved-sessions");
      const metadataRoot = join(cakeHome, "state", "resolved-project-metadata");
      const entryPath = join(metadataRoot, "projects", digest(project), `${digest(targetId)}.json`);
      const requests: Array<{ messages?: Array<{ role: string; content: unknown }> }> = [];
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          requests.push(JSON.parse(body));
          const invocation =
            requests.length === 1
              ? { command: "sessions.open", input: { sessionId: targetId } }
              : requests.length === 2 && scenario === "migrated"
                ? {
                    command: "sessions.resolve",
                    input: { targets: [{ kind: "project", sessionId: sourceId }], resolved: true },
                  }
                : undefined;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            chunk(
              invocation
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call-${requests.length}`,
                        type: "function",
                        function: { name: "cake", arguments: JSON.stringify(invocation) },
                      },
                    ],
                  }
                : { content: "Moved and resolved." },
            ) +
              chunk({}, invocation ? "tool_calls" : "stop") +
              "data: [DONE]\n\n",
          );
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const sourceDirectory = cakeWorkspaceSessionDirectory(project, activeRoot);
      const targetDirectory = cakeWorkspaceSessionDirectory(workingDirectory, resolvedRoot);
      const oldDirectory = cakeWorkspaceSessionDirectory(workingDirectory, oldActiveRoot);
      const sourceFile = join(sourceDirectory, `1970-01-01T00-00-00-000Z_${sourceId}.jsonl`);
      const targetFile = join(targetDirectory, `1970-01-01T00-00-00-000Z_${targetId}.jsonl`);
      const transcript = (id: string, cwd: string, text: string) =>
        [
          { type: "session", version: 3, id, timestamp, cwd },
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
      await Promise.all(
        [
          userData,
          project,
          workingDirectory,
          sourceDirectory,
          targetDirectory,
          oldDirectory,
          join(metadataRoot, "projects", digest(project)),
          join(metadataRoot, "sessions", digest(targetId).slice(0, 2)),
          join(metadataRoot, "migrations"),
        ].map((path) => mkdir(path, { recursive: true })),
      );
      await writeFile(sourceFile, transcript(sourceId, project, "Find my earlier conversation."));
      const archived = transcript(targetId, workingDirectory, "Archived sharing discussion.");
      if (scenario === "migrated") await writeFile(targetFile, archived);
      await writeFile(join(oldDirectory, `1970-01-01T00-00-00-000Z_${targetId}.jsonl`), archived);
      await writeFile(
        entryPath,
        JSON.stringify({
          version: scenario === "migrated" ? 1 : 2,
          sessionId: targetId,
          projectPath: project,
          projectName: "project",
          workingDirectory,
          activeRoot: oldActiveRoot,
          resolvedRoot: oldResolvedRoot,
          createdAt: timestamp,
          modifiedAt: timestamp,
        }),
      );
      await writeFile(
        join(metadataRoot, "sessions", digest(targetId).slice(0, 2), `${digest(targetId)}.json`),
        JSON.stringify({ version: 1, projectPath: project }),
      );
      await writeFile(
        join(metadataRoot, "migrations", `${digest(project)}.project-archives-v1`),
        JSON.stringify({ version: 1, projectPath: project }),
      );
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
          trustedProjectPaths: [project, workingDirectory],
          utilityModel: {
            provider: "navigation-provider",
            modelId: "fixture-model",
            thinkingLevel: "off",
          },
        }),
      );
      await writeFile(
        join(cakeHome, "state", "worktrees.json"),
        JSON.stringify({
          schemaVersion: 1,
          records: [
            {
              projectPath: project,
              worktreePath: workingDirectory,
              branch: "agent/archive",
              baseBranch: "main",
              state: "active",
              createdAt: timestamp,
            },
          ],
        }),
      );
      await writeFile(
        join(userData, "window-state.json"),
        JSON.stringify({
          projectPath: project,
          selectedSessionId: sourceId,
          activeConversation: {
            kind: "project-session",
            workspacePath: project,
            sessionId: sourceId,
          },
          recentProjectPaths: [project],
          draft: "",
        }),
      );
      const application = await electron.launch({
        args: [repositoryRoot],
        cwd: repositoryRoot,
        env: {
          ...process.env,
          CAKE_ELECTRON_SMOKE: "1",
          CAKE_ELECTRON_USER_DATA: userData,
          CAKE_HOME: cakeHome,
        },
      });
      try {
        await installLocalModelHttpGuard(application, origin);
        const page = await application.firstWindow();
        await expect(
          page.locator(".transcript").getByText("Find my earlier conversation.", { exact: true }),
        ).toBeVisible({ timeout: 20_000 });
        await page.getByRole("button", { name: "Expand Resolved", exact: true }).click();
        await page
          .getByRole("button", { name: "Expand project resolved", exact: true })
          .last()
          .click();
        await expect(page.locator(`.session-item[data-session-id="${targetId}"]`)).toBeVisible();
        await page.getByRole("button", { name: "Ask session assistant", exact: true }).click();
        const input = page.getByRole("combobox", { name: "Ask session assistant", exact: true });
        await expect(input).toBeFocused();
        await input.fill("Take me to that session and then resolve this session.");
        await expect(input).toHaveValue("Take me to that session and then resolve this session.");
        await expect(page.getByRole("button", { name: "Send", exact: true }).last()).toBeEnabled();
        await input.press("Enter");
        if (scenario === "unavailable") {
          await expect.poll(() => requests.length).toBe(2);
          expect(
            requests[1]!
              .messages!.filter((message) => message.role === "tool")
              .map((message) => JSON.parse(String(message.content))),
          ).toContainEqual(expect.objectContaining({ command: "sessions.open", ok: false }));
          await expect(
            page.locator(".transcript").getByText("Find my earlier conversation.", { exact: true }),
          ).toBeVisible();
          await expect(
            page.getByText("That session is no longer available", { exact: true }),
          ).toBeVisible();
          const live = page.locator('[data-slot="content-transition-live"]').first();
          await expect(live).not.toHaveClass(/opacity-0/);
          expect(await live.evaluate((element) => element.inert)).toBe(false);
          const composer = page.getByRole("combobox", { name: "Message", exact: true });
          await composer.click();
          await expect(composer).toBeFocused();
          await composer.pressSequentially("Continue the original conversation.");
          await expect(composer).toHaveValue("Continue the original conversation.");
          await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
          // Repair the external storage boundary and retry the same stopped observation.
          await writeFile(targetFile, archived);
          const entry = JSON.parse(await readFile(entryPath, "utf8"));
          await writeFile(entryPath, JSON.stringify({ ...entry, activeRoot, resolvedRoot }));
          await page.locator(`.session-item[data-session-id="${targetId}"] .session-row`).click();
          await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
            "data-session-id",
            targetId,
          );
          await expect(
            page.locator(".transcript").getByText("Archived sharing discussion.", { exact: true }),
          ).toBeVisible();
          expect(await readFile(sourceFile, "utf8")).toContain("Find my earlier conversation.");
          return;
        }
        await expect(page.locator('[data-slot="session-pane"]')).toHaveAttribute(
          "data-session-id",
          targetId,
          { timeout: 15_000 },
        );
        await expect(
          page.locator(".transcript").getByText("Archived sharing discussion.", { exact: true }),
        ).toBeVisible();
        await expect.poll(() => requests.length).toBe(3);
        const results = requests[2]!
          .messages!.filter((message) => message.role === "tool")
          .map((message) => String(message.content));
        expect(
          results.some(
            (result) =>
              result.includes('"command": "sessions.open"') && result.includes('"ok": true'),
          ),
        ).toBe(true);
        expect(results.map((result) => JSON.parse(result))).toContainEqual(
          expect.objectContaining({ command: "sessions.resolve", ok: true }),
        );
        const entry = JSON.parse(await readFile(entryPath, "utf8"));
        expect(entry).toMatchObject({ version: 2, activeRoot, resolvedRoot });
        expect(await readFile(targetFile, "utf8")).toBe(archived);
        await expect
          .poll(async () => {
            try {
              await readFile(sourceFile);
              return false;
            } catch {
              return true;
            }
          })
          .toBe(true);
      } finally {
        await application.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
