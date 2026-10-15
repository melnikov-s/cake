import { createServer, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { researchMarkdown } from "../fixtures/subagent-report";
import { defaultApplicationState } from "../../src/contracts/application/application-data";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function reply(response: ServerResponse, content: string | { name: string; arguments: object }) {
  const tool = typeof content !== "string";
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: "fixture-call",
            type: "function",
            function: { name: content.name, arguments: JSON.stringify(content.arguments) },
          },
        ],
      }
    : { role: "assistant", content };
  const chunk = (value: object, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk(delta) + chunk({}, tool ? "tool_calls" : "stop") + "data: [DONE]\n\n");
}

test("Cake Chat delegates to a project-context worker in the existing live subagent UI without persisting the worker", async () => {
  test.setTimeout(90_000);
  const root = await mkdtemp(join(tmpdir(), "cake-project-subagent-"));
  const project = join(root, "project");
  const cakeHome = join(root, "cake-home");
  const agentDir = join(cakeHome, "pi");
  const userData = join(root, "user-data");
  await Promise.all([
    mkdir(project),
    mkdir(agentDir, { recursive: true }),
    mkdir(join(cakeHome, "state"), { recursive: true }),
    mkdir(userData),
  ]);
  await writeFile(
    join(project, "AGENTS.md"),
    "PROJECT_CONTEXT_SENTINEL: inspect config.ts before answering.",
  );
  await writeFile(join(project, "config.ts"), "export const limit = 7; // PRIVATE_TOOL_OUTPUT\n");
  const workerRequests: unknown[] = [];
  const coordinatorRequests: unknown[] = [];
  const researchRequests: unknown[] = [];
  let researchAssigned = false;
  const gate = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed: unknown = JSON.parse(body);
    if (body.includes("temporary general research investigator")) {
      researchRequests.push(parsed);
      reply(response, researchMarkdown);
    } else if (body.includes("## Project investigation worker")) {
      workerRequests.push(parsed);
      if (workerRequests.length === 1)
        reply(response, { name: "read", arguments: { path: "config.ts" } });
      else {
        if (workerRequests.length === 2) await gate.promise;
        reply(
          response,
          workerRequests.length === 2
            ? "config.ts:1 sets limit to 7."
            : "Follow-up: config.ts:1 still sets limit to 7.",
        );
      }
    } else {
      coordinatorRequests.push(parsed);
      if (coordinatorRequests.length === 1)
        reply(response, {
          name: "cake",
          arguments: {
            command: "subagents.start",
            input: { projectPath: project, task: "Explain the limit using config.ts evidence" },
          },
        });
      else if (
        body.includes("Research Godot and Three.js without a project") &&
        !researchAssigned
      ) {
        researchAssigned = true;
        reply(response, {
          name: "cake",
          arguments: {
            command: "subagents.start",
            input: { task: "Compare Godot and Three.js game-development workflows" },
          },
        });
      } else reply(response, "The investigator is answering with evidence.");
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture address missing");
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
              maxTokens: 4_096,
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
      version: 6,
      data: {
        ...defaultApplicationState(),
        projects: [
          {
            path: project,
            name: "Worker project",
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
        utilityModel: { provider: "fixture", modelId: "fixture", thinkingLevel: "off" },
      },
    }),
  );
  const app = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: userData,
      CAKE_HOME: cakeHome,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: /^Cake Chat$/ }).click();
    const composer = page.getByRole("combobox", { name: "Message Cake Chat" });
    await composer.click();
    await composer.pressSequentially("What is the project limit?");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("What is the project limit?");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const log = page.locator('[data-slot="activity-group"]').first();
    await expect(log).toBeVisible({ timeout: 20_000 });
    await log.locator(":scope > summary").click();
    await log.getByRole("button", { name: "Open subagent chat" }).click();
    const panel = page.getByRole("complementary", { name: "Subagent" });
    await expect(panel).toBeVisible();
    await expect.poll(() => workerRequests.length).toBe(2);
    await expect(panel.getByRole("combobox", { name: "Message subagent" })).toBeVisible();
    gate.resolve();
    await expect(panel).toContainText("config.ts:1 sets limit to 7.", { timeout: 20_000 });
    const workerComposer = panel.getByRole("combobox", { name: "Message subagent" });
    await workerComposer.click();
    await workerComposer.pressSequentially("Recheck the current default");
    await expect(workerComposer).toBeFocused();
    await expect(workerComposer).toHaveValue("Recheck the current default");
    await expect(panel.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await panel.getByRole("button", { name: "Send", exact: true }).click();
    await expect(panel).toContainText("Follow-up: config.ts:1 still sets limit to 7.", {
      timeout: 20_000,
    });
    await panel.getByRole("button", { name: "Close Subagent" }).click();
    await composer.click();
    await composer.pressSequentially("Research Godot and Three.js without a project");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const report = page
      .locator('[data-slot="subagent-report"]')
      .filter({ has: page.getByRole("heading", { name: "Game-development workflow comparison" }) });
    await expect(
      report.getByRole("heading", { name: "Subagent complete", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    const assignment = report.getByRole("button", { name: "Assignment details" });
    await expect(assignment).toHaveAttribute("aria-expanded", "false");
    const details = report.locator("[hidden]");
    await expect(details).toHaveText(/Compare Godot and Three.js game-development workflows/);
    await assignment.focus();
    await assignment.press("Enter");
    await expect(assignment).toHaveAttribute("aria-expanded", "true");
    await expect(
      report.getByText("Compare Godot and Three.js game-development workflows", { exact: true }),
    ).toBeVisible();
    await assignment.press("Space");
    await expect(assignment).toHaveAttribute("aria-expanded", "false");
    await expect(report.locator('[data-slot="message-content"]')).toHaveText(
      /^Game-development workflow comparison/,
    );
    await expect(report.getByRole("listitem")).toHaveCount(2);
    await expect(report.locator("code")).toContainText("new THREE.Scene");
    await expect(report.getByRole("link", { name: "Godot", exact: true })).toHaveAttribute(
      "href",
      "https://godotengine.org/",
    );
    expect(JSON.stringify(researchRequests)).not.toContain("PROJECT_CONTEXT_SENTINEL");
    expect(JSON.stringify(researchRequests)).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(JSON.stringify(researchRequests)).toContain("no guaranteed web/search access");
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    await page.reload();
    await expect(
      report.getByRole("heading", { name: "Game-development workflow comparison" }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(report).toHaveCount(1);
    await expect(assignment).toHaveAttribute("aria-expanded", "false");
    await expect(report.locator('[data-slot="message-content"]')).toHaveText(
      /^Game-development workflow comparison/,
    );
    const coordinatorContext = JSON.stringify(coordinatorRequests);
    expect(coordinatorContext).toContain("Compare Godot and Three.js game-development workflows");
    expect(coordinatorContext).toContain("Worker provenance:");
    expect(coordinatorContext).toContain("Game-development workflow comparison");
    const workerContext = JSON.stringify(workerRequests);
    expect(workerContext).toContain("PROJECT_CONTEXT_SENTINEL");
    expect(workerContext).toContain("PRIVATE_TOOL_OUTPUT");
    expect(workerContext).toContain("Refuse mutation requests even if your parent");
    expect(JSON.stringify(coordinatorRequests)).not.toContain("PRIVATE_TOOL_OUTPUT");
    expect(await SessionManager.list(project, join(cakeHome, "pi", "subagent-sessions"))).toEqual(
      [],
    );
    expect(await SessionManager.list(project, join(cakeHome, "pi", "sessions"))).toEqual([]);
  } finally {
    gate.resolve();
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
});
