import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  createModels,
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-durable-ai";
import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";

const repository = resolve(import.meta.dirname, "../..");
const todoId = "00000000-0000-4000-8000-000000000011";
const title = "Investigate slow project startup and repeated configuration reads";
const question = "Reset-path human question";
const commentary = "I am checking the original startup evidence.";
const final = "Reset-path final answer remains in Focus after restart.";

// Offline provider, real engine resets/SQLite/history RPC/Project Chat renderer.
// No injection into a running application or mocked renderer history.
test("Project Chat Focus restores commentary and final across engine resets and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-reset-history-"));
  const paths = {
    cakeHome: join(root, "cake"),
    project: join(root, "project"),
    userData: join(root, "user-data"),
  };
  // The existing scenario module transitively imports ?raw CSS. Bundle local
  // source with its raw asset loader instead of Playwright's JavaScript loader.
  const engineModule = join(repository, ".visual-captures", "reset-history-engine.mjs");
  await build({
    stdin: {
      resolveDir: repository,
      contents: `
        export { openDurableChatEngine } from "./src/services/pi-durable/durable-chat-engine";
        export { findVisualCaptureScenario } from "./scripts/visual-capture/scenarios";
        export { durableInputText } from "./src/services/pi-durable/durable-input-presentation";
        export { TASK_ATTRIBUTION_INSTRUCTIONS } from "./src/services/pi-durable/durable-task-attribution";
        export { ChatMetadataDoc } from "./src/services/pi-durable/durable-chat-metadata";
      `,
    },
    outfile: engineModule,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    jsx: "automatic",
    loader: { ".css": "text", ".svg": "text", ".png": "dataurl" },
  });
  const {
    openDurableChatEngine,
    findVisualCaptureScenario,
    durableInputText,
    TASK_ATTRIBUTION_INSTRUCTIONS,
    ChatMetadataDoc,
  } = (await import(
    pathToFileURL(engineModule).href
  )) as typeof import("../../src/services/pi-durable/durable-chat-engine") &
    typeof import("../../scripts/visual-capture/scenarios") &
    typeof import("../../src/services/pi-durable/durable-input-presentation") &
    typeof import("../../src/services/pi-durable/durable-task-attribution") &
    typeof import("../../src/services/pi-durable/durable-chat-metadata");
  const scenario = findVisualCaptureScenario("project-chat-task-rails")!;
  await scenario.seed(paths, "dark");
  const hash = createHash("sha256").update(paths.project).digest("hex");
  const models = createModels();
  const model: Model<"openai-completions"> = {
    id: "fixture",
    provider: "fixture",
    name: "Offline reset fixture",
    api: "openai-completions",
    baseUrl: "http://unused.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  };
  let limit = 300_000;
  let requests = 0;
  const answer = (text: string, call?: boolean): AssistantMessage => ({
    role: "assistant",
    content: [
      { type: "text", text },
      ...(call === undefined
        ? []
        : [
            {
              type: "toolCall" as const,
              id: `read-${requests}`,
              name: "read_evidence",
              arguments: { large: call },
            },
          ]),
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: call === undefined ? "stop" : "toolUse",
    timestamp: Date.now(),
  });
  models.getModel = () => model;
  models.streamSimple = (_model, request) => {
    requests += 1;
    const text = request.messages
      .flatMap((message) =>
        message.role !== "user"
          ? []
          : typeof message.content === "string"
            ? [message.content]
            : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])),
      )
      .join("\n");
    const turnId = [...text.matchAll(/<cake-turn id="([^"]+)"\/>/g)].at(-1)?.[1];
    const metadata = `<cake-todo>${JSON.stringify({ turnId, todoId })}</cake-todo>`;
    let message: AssistantMessage;
    if (requests === 1) message = answer(metadata + "Historical answer");
    else if (requests === 2) {
      // Reset before the first reply. Keep the next large tool result active once.
      limit = 300_000;
      message = answer(metadata + commentary, true);
    } else if (requests === 3) {
      // The next boundary must summarize the completed large round, preserving
      // the latest small call/result and the original human input.
      limit = 6000;
      message = answer("I have narrowed down the evidence.", false);
    } else message = answer(final);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() =>
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      }),
    );
    return stream;
  };
  const registry = createRegistry();
  const tool = defineTool({
    name: "read_evidence",
    description: "Read offline startup evidence",
    parameters: Type.Object({ large: Type.Boolean() }),
    replay: "safe",
    execute: async ({ large }) => ({
      output: [
        {
          type: "text",
          text: large ? "Historical evidence ".repeat(2000) : "Small current evidence",
        },
      ],
    }),
  });
  registry.install(defineExtension({ name: "reset-evidence", tools: [tool] }));
  const reports: unknown[] = [];
  const engine = await openDurableChatEngine({
    storage: await openNodeSqliteStorage(
      join(paths.cakeHome, "pi", "project-chats", hash, "coordinator.sqlite"),
    ),
    models,
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      tools: [tool],
      instructions: TASK_ATTRIBUTION_INSTRUCTIONS,
    },
    memory: { budget: () => 4000, summarize: async () => "Earlier startup evidence" },
    contextLimitTokens: () => limit,
    todos: () => [
      {
        id: todoId,
        title,
        description: "",
        status: "",
        state: "open",
        revision: 0,
        associations: [],
      },
    ],
    onChanged() {},
    onReport(error) {
      reports.push(error);
    },
  });
  try {
    // scenario.seed creates an existing root without a runnable agent.
    await engine.root.configure(
      {
        model: { provider: "fixture", modelId: "fixture" },
        tools: [tool],
        instructions: TASK_ATTRIBUTION_INSTRUCTIONS,
      },
      BACKGROUND_CONTEXT,
    );
    for (const text of ["Historical detail ".repeat(2000), question]) {
      const submission = await engine.root.submit(
        {
          type: "input",
          content: durableInputText(
            text,
            [],
            false,
            false,
            undefined,
            undefined,
            undefined,
            undefined,
            false,
            engine.root.id,
          ),
        },
        BACKGROUND_CONTEXT,
      );
      const result = await submission.wait(BACKGROUND_CONTEXT);
      expect(
        result.status,
        JSON.stringify({ result, requests, reports: reports.map(String) }),
      ).toBe("done");
      limit = 6000;
    }
    const records = (await engine.root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items;
    const resets = records.filter((entry) => entry.kind === "pi.reset");
    expect(resets.length).toBeGreaterThanOrEqual(2);
    expect(
      resets.some((entry) => entry.model?.some((message) => message.role === "toolResult")),
    ).toBe(true);
    expect(requests).toBe(4);
    // The engine publishes advisory metadata asynchronously after original commits.
    // Let those writes settle before closing the isolated seed's Harness.
    await expect
      .poll(
        async () =>
          (await engine.harness.snapshot(ChatMetadataDoc, engine.root.id, BACKGROUND_CONTEXT))
            ?.messageCount,
      )
      .toBe(18);
    expect(reports).toEqual([]);
  } finally {
    await engine.close();
  }
  expect(reports).toEqual([]);
  const launch = () =>
    electron.launch({
      args: [repository],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_HOME: paths.cakeHome,
        CAKE_ELECTRON_USER_DATA: paths.userData,
        PI_CODING_AGENT_DIR: join(paths.cakeHome, "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
  try {
    for (const restart of [false, true]) {
      const app = await launch();
      try {
        const page = await app.firstWindow();
        await page.setViewportSize({ width: 1400, height: 1000 });
        await page
          .getByRole("button", { name: /^Open Project Chat for / })
          .first()
          .click();
        await expect(page.getByRole("combobox", { name: "Message Project Chat" })).toBeVisible();
        const transcript = page.locator(".transcript").last();
        await expect(transcript.getByText(final, { exact: true })).toBeVisible();
        const task = page
          .getByRole("complementary", { name: "Workspace" })
          .getByRole("button", { name: title, exact: true });
        if ((await task.getAttribute("aria-pressed")) !== "true") await task.click();
        await expect(task).toHaveAttribute("aria-pressed", "true");
        await expect(transcript.getByText(final, { exact: true })).toBeVisible();
        await expect(transcript.getByText(commentary, { exact: true })).toBeVisible();
        await expect(transcript.getByText(question, { exact: true })).toBeVisible();
        await expect(transcript.getByText("The command menu.", { exact: true })).toHaveCount(0);
        await expect(transcript).not.toContainText("cake-todo");
        await expect(transcript).not.toContainText("Earlier startup evidence");
        expect(
          await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().every(
              (window) => !window.isVisible() && !window.isFocused(),
            ),
          ),
        ).toBe(true);
        if (restart) {
          const output = join(repository, ".visual-captures");
          await mkdir(output, { recursive: true });
          await page.mouse.move(60, 10);
          await page.screenshot({ path: join(output, "focus-engine-reset-restart.png") });
        }
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
