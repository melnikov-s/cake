import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { installLocalModelHttpGuard } from "./main-harness";

const repository = resolve(import.meta.dirname, "../..");
const chunk = (delta: object, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: "trust", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

for (const action of ["Confirm", "Decline", "Cancel"] as const) {
  test(`agent-created Project trust handoff: ${action}`, async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), "cake-project-trust-"));
    const cakeHome = join(root, "cake");
    const userData = join(root, "user-data");
    const project = join(root, "created-project");
    await Promise.all(
      [project, userData, join(cakeHome, "state"), join(cakeHome, "pi")].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    let step = 0;
    let workerRequests = 0;
    const receipts: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      const parsed: { messages: Array<{ role: string; content: unknown }> } = JSON.parse(body);
      const lastUser = JSON.stringify(
        parsed.messages.findLast((message) => message.role === "user")?.content,
      );
      const summary = /Compaction: (?:compress message|merge lines)/.test(lastUser);
      const coordinator = !summary && lastUser.includes("Create onboarding fixture");
      const worker = !summary && lastUser.includes("WORKER_TRUST_HANDOFF");
      if (worker) workerRequests += 1;
      if (coordinator && parsed.messages.at(-1)?.role === "tool")
        receipts.push(String(parsed.messages.at(-1)!.content));
      let invocation: { command: string; input: object } | undefined;
      if (coordinator) {
        const current = step++;
        if (current === 0) invocation = { command: "projects.add", input: { path: project } };
        // Prove that registration cannot authorize even a direct worker-launch attempt.
        if (current === 1)
          invocation = {
            command: "sessions.create",
            input: {
              workspacePath: project,
              name: "Blocked worker",
              initialPrompt: "MUST_NOT_LAUNCH",
              resultDelivery: "ignore",
            },
          };
        if (current === 2)
          invocation = { command: "projects.request-trust", input: { path: project } };
        if (current === 3 && action === "Confirm")
          invocation = {
            command: "sessions.create",
            input: {
              workspacePath: project,
              name: "Authorized worker",
              initialPrompt: "WORKER_TRUST_HANDOFF: implement the authorized fixture",
              resultDelivery: "ignore",
            },
          };
      }
      const text = coordinator ? "Onboarding fixture finished." : "Fixture worker completed.";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        chunk(
          invocation
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `trust-${step}`,
                    type: "function",
                    function: { name: "cake", arguments: JSON.stringify(invocation) },
                  },
                ],
              }
            : { role: "assistant", content: text },
        ) +
          chunk({}, invocation ? "tool_calls" : "stop") +
          "data: [DONE]\n\n",
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture server");
    const origin = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `${origin}/v1`,
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
                maxTokens: 1024,
              },
            ],
          },
        },
      }),
    );
    const presetId = "00000000-0000-4000-8000-000000000001";
    const applicationPath = join(cakeHome, "state", "application.json");
    await writeFile(
      applicationPath,
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
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
    const app = await electron.launch({
      args: [repository],
      cwd: repository,
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
      await installLocalModelHttpGuard(app, origin);
      const page = await app.firstWindow();
      await page.getByRole("button", { name: "Cake Chat", exact: true }).first().click();
      const composer = page.getByRole("combobox", { name: "Message Cake Chat", exact: true });
      await composer.focus();
      await expect(composer).toBeFocused();
      await composer.pressSequentially("Create onboarding fixture");
      await expect(composer).toHaveValue("Create onboarding fixture");
      await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
      await composer.press("Enter");
      const dialog = page.getByRole("alertdialog", { name: "Trust this Project and continue?" });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(project);
      await expect(dialog).toContainText("execute code on your computer");
      expect(JSON.parse(receipts[0]!)).toMatchObject({
        project: { path: project, trusted: false },
      });
      expect(receipts[1]).toContain("is not trusted");
      expect(workerRequests).toBe(0);
      expect(
        JSON.parse(await readFile(applicationPath, "utf8")).data.trustedProjectPaths,
      ).not.toContain(project);
      await dialog.getByRole("button", { name: action, exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText("Onboarding fixture finished.", { exact: true })).toBeVisible();
      const approved = action === "Confirm";
      expect(JSON.parse(receipts[2]!)).toMatchObject({
        decision: approved ? "approved" : action === "Decline" ? "declined" : "cancelled",
        project: { path: project, trusted: approved },
      });
      // The current Cake Chat remains selected; trust does not open the new Project.
      await expect(composer).toBeVisible();
      const paths = JSON.parse(await readFile(applicationPath, "utf8")).data.trustedProjectPaths;
      expect(paths.includes(project)).toBe(approved);
      if (approved) {
        expect(JSON.parse(receipts[3]!)).toMatchObject({
          status: "started",
          workspacePath: project,
        });
        // Observe the actual worker's provider request, not just the launch receipt.
        await expect.poll(() => workerRequests).toBeGreaterThan(0);
      } else expect(workerRequests).toBe(0);
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await new Promise<void>((done) => server.close(() => done()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
