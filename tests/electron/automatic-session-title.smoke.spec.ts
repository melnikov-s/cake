import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function chunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "title-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

for (const draft of [false, true]) {
  test(
    draft
      ? "automatically names and persists a newly saved draft"
      : "renames a newly submitted session before the assistant turn finishes",
    async () => {
      test.setTimeout(60_000);
      const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-auto-title-"));
      const userData = join(temporaryRoot, "user-data");
      const project = join(temporaryRoot, "project");
      const cakeHome = join(temporaryRoot, "cake-home");
      let titleResponse: ServerResponse | undefined;
      let assistantResponse: ServerResponse | undefined;
      const titleRequests: string[] = [];
      const server = createServer(async (request, response) => {
        if (request.method === "GET") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] }),
          );
          return;
        }
        let body = "";
        for await (const data of request) body += data;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (body.includes("Create a concise title for a coding-agent session")) {
          titleRequests.push(body);
          titleResponse = response;
        } else if (body.includes("Choose up to three labels")) {
          response.end(
            chunk({ role: "assistant", content: "[]" }) + chunk({}, "stop") + "data: [DONE]\n\n",
          );
        } else {
          assistantResponse = response;
          response.write(chunk({ role: "assistant", content: "Work is running." }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP server");
      await Promise.all([
        mkdir(userData, { recursive: true }),
        mkdir(project, { recursive: true }),
        mkdir(join(cakeHome, "pi"), { recursive: true }),
        mkdir(join(cakeHome, "state"), { recursive: true }),
      ]);
      await writeFile(
        join(cakeHome, "pi", "models.json"),
        JSON.stringify({
          providers: {
            "title-provider": {
              name: "Title provider",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              apiKey: "fixture",
              api: "openai-completions",
              models: [
                {
                  id: "fixture-model",
                  name: "Title fixture",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        }),
      );
      await writeFile(
        join(userData, "window-state.json"),
        JSON.stringify({
          projectPath: project,
          recentProjectPaths: [project],
          draft: "",
          theme: "dark",
        }),
      );
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
          trustedProjectPaths: [project],
          utilityModel: {
            provider: "title-provider",
            modelId: "fixture-model",
            thinkingLevel: "off",
          },
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
          PI_CODING_AGENT_DIR: join(cakeHome, "pi"),
          PI_CODING_AGENT_SESSION_DIR: "",
        },
      });
      try {
        const page = await application.firstWindow();
        await page.getByRole("button", { name: "Model configuration" }).click({ timeout: 20_000 });
        await page.getByLabel("Search presets and models").fill("Title fixture");
        await page
          .getByRole("button", { name: /Title fixture/ })
          .first()
          .click();
        await page.getByRole("button", { name: "Apply", exact: true }).click();
        if (draft) await page.getByRole("button", { name: "Draft", exact: true }).click();
        const composer = page.getByRole("combobox", { name: "Message", exact: true });
        await composer.click();
        await expect(composer).toBeFocused();
        await composer.pressSequentially("Investigate automatic session naming");
        await expect(composer).toHaveValue("Investigate automatic session naming");
        await expect(
          page.getByRole("button", { name: draft ? "Create draft" : "Send", exact: true }),
        ).toBeEnabled();
        await composer.press("Enter");
        await expect.poll(() => Boolean(titleResponse && (draft || assistantResponse))).toBe(true);
        if (draft) {
          await expect(page.getByRole("button", { name: "Activate draft" })).toBeVisible();
          expect(assistantResponse).toBeUndefined();
        } else {
          await expect(page.getByText("Work is running.", { exact: true })).toBeVisible();
          await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        }
        expect(titleRequests).toHaveLength(1);
        const request = JSON.parse(titleRequests[0]!);
        expect(request.max_tokens ?? request.max_completion_tokens).toBe(2_048);
        titleResponse!.end(
          chunk({ role: "assistant", content: "Fix automatic session titles" }) +
            chunk({}, "stop") +
            "data: [DONE]\n\n",
        );
        const row = page
          .locator(".session-item")
          .filter({ hasText: "Fix automatic session titles" });
        await expect(row).toBeVisible();
        if (draft) {
          const savedDraftFile = join(cakeHome, "state", "saved-drafts.json");
          await expect
            .poll(async () => JSON.parse(await readFile(savedDraftFile, "utf8")).records[0]?.title)
            .toBe("Fix automatic session titles");
          await page.reload();
          await expect(row).toBeVisible();
          await row.click();
          await expect(page.getByRole("button", { name: "Activate draft" })).toBeVisible();
          expect(titleRequests).toHaveLength(1);
          return;
        }
        await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        const directory = cakeWorkspaceSessionDirectory(project, join(cakeHome, "pi", "sessions"));
        await expect
          .poll(async () => {
            const file = (await readdir(directory)).find((name) => name.endsWith(".jsonl"));
            return file
              ? (await readFile(join(directory, file), "utf8")).includes(
                  '"name":"Fix automatic session titles"',
                )
              : false;
          })
          .toBe(true);
        assistantResponse!.end(chunk({}, "stop") + "data: [DONE]\n\n");
        await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
        await expect(row).toBeVisible();
        expect(titleRequests).toHaveLength(1);
      } finally {
        await application.close();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
  );
}
