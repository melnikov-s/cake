import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import {
  AutomationId,
  AutomationRunId,
  AutomationOccurrenceId,
  type AutomationDefinition,
  type AutomationRun,
  type AutomationOccurrence,
  type Automation,
} from "../../src/contracts/automations/automation-data";
import { OptMemoryId } from "../../src/contracts/memory/opt-memory-data";
import { makeOptMemoryLive } from "../../src/services/opt-memory/OptMemoryLive";
import { OptMemory } from "../../src/services/opt-memory/OptMemory";
import { store, windowStateDocument } from "./window-state";

const visualAutomationId = AutomationId.make("10000000-0000-4000-8000-000000000001");
const visualProjectAutomationId = AutomationId.make("10000000-0000-4000-8000-000000000002");
const visualMemoryId = OptMemoryId.make("40000000-0000-4000-8000-000000000001");
const visualSessionId = "20000000-0000-4000-8000-000000000001";

/** Real backend records/Pi originals; only the external model is a local deterministic provider. */
export async function seedAutomationVisualFixture(
  paths: { cakeHome: string; project: string; userData: string },
  theme: "light" | "dark",
) {
  const responses = new Set<ServerResponse>();
  let modelRequests = 0;
  const server = createServer((request, response) => {
    modelRequests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "automation-fixture", object: "chat.completion.chunk", created: 0, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Reviewing the latest project changes and shared automation memory." }, finish_reason: null }] })}\n\n`,
    );
    responses.add(response);
    response.on("close", () => responses.delete(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected a local TCP fixture provider");
  const close = async () => {
    for (const response of responses) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  try {
    await Promise.all([
      mkdir(paths.project, { recursive: true }),
      mkdir(paths.userData, { recursive: true }),
      mkdir(join(paths.cakeHome, "state"), { recursive: true }),
      mkdir(join(paths.cakeHome, "pi"), { recursive: true }),
    ]);
    const timestamp = "2030-01-01T09:00:00.000Z";
    const configuration = {
      provider: "automation-fixture",
      modelId: "fixture",
      thinkingLevel: "off" as const,
      fastMode: false,
    };
    const definition: AutomationDefinition = {
      name: "Morning brief",
      context: { _tag: "Global" },
      trigger: {
        _tag: "Schedule",
        schedule: { _tag: "Interval", startsAt: "2099-01-01T09:00:00.000Z", everySeconds: 86400 },
      },
      task: { prompt: "Review open work using shared memory.", configuration, attachments: [] },
      overlap: "queue",
      completion: "keep-for-review",
    };
    const automations: Automation[] = [
      {
        id: visualAutomationId,
        definition,
        state: { _tag: "paused" },
        memoryId: visualMemoryId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: visualProjectAutomationId,
        definition: {
          ...definition,
          name: "Review child replies",
          context: { _tag: "Project", projectPath: paths.project },
          trigger: {
            _tag: "Event",
            filter: {
              event: "assistant-response-completed",
              scope: { _tag: "Project", projectPath: paths.project },
              sessionKinds: ["family-child"],
            },
          },
          overlap: "parallel",
        },
        state: { _tag: "paused" },
        memoryId: OptMemoryId.make("40000000-0000-4000-8000-000000000002"),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
    const runs: AutomationRun[] = automations.map((automation, index) => ({
      id: AutomationRunId.make(`20000000-0000-4000-8000-00000000000${index + 1}`),
      automationId: automation.id,
      occurrenceId: AutomationOccurrenceId.make(`30000000-0000-4000-8000-00000000000${index + 1}`),
      sessionId: `20000000-0000-4000-8000-00000000000${index + 1}`,
      context: automation.definition.context,
      workingDirectory: index ? paths.project : homedir(),
      sessionDirectory: join(paths.cakeHome, "pi", "sessions", "automations", automation.id),
      startedAt: timestamp,
      status: { _tag: "completed", finishedAt: "2030-01-01T09:01:00.000Z" },
    }));
    const occurrences: AutomationOccurrence[] = runs.map((run, index) => ({
      id: run.occurrenceId,
      automationId: run.automationId,
      source: { _tag: "Manual" },
      occurredAt: timestamp,
      definition: automations[index]!.definition,
      disposition: { _tag: "started", runId: run.id },
    }));
    await writeFile(
      join(paths.cakeHome, "state", "automations.json"),
      JSON.stringify({ version: 1, data: { automations, runs, occurrences } }),
    );
    await writeFile(
      join(paths.cakeHome, "state", "application.json"),
      JSON.stringify({
        version: 7,
        data: {
          ...defaultApplicationState(),
          projects: [
            { path: paths.project, name: "Cake", addedAt: timestamp, lastOpenedAt: timestamp },
          ],
          unreadSessionIds: runs.map((run) => run.sessionId),
          modelPresets: [
            { id: "50000000-0000-4000-8000-000000000001", name: "Fixture", ...configuration },
          ],
          defaultModelPresetId: "50000000-0000-4000-8000-000000000001",
        },
      }),
    );
    await writeFile(
      join(paths.cakeHome, "pi", "models.json"),
      JSON.stringify({
        providers: {
          "automation-fixture": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture",
            models: [
              {
                id: "fixture",
                name: "Fixture model",
                reasoning: false,
                input: ["text"],
                contextWindow: 64000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(paths.userData, "window-state.json"),
      windowStateDocument({
        appShellStore: store({
          navigationVersion: 3,
          workspace: "home",
          coveringSurface: "automations",
        }),
        settingsStore: store({}, { appearance: store({ theme }) }),
      }),
    );
    for (const [index, run] of runs.entries()) {
      await mkdir(run.sessionDirectory, { recursive: true });
      const entries = [
        { type: "session", version: 3, id: run.sessionId, timestamp, cwd: run.workingDirectory },
        {
          type: "model_change",
          id: "model",
          parentId: null,
          timestamp,
          provider: configuration.provider,
          modelId: configuration.modelId,
        },
        {
          type: "message",
          id: "user",
          parentId: "model",
          timestamp,
          message: {
            role: "user",
            content: [{ type: "text", text: automations[index]!.definition.task.prompt }],
            timestamp: 0,
          },
        },
        {
          type: "message",
          id: "assistant",
          parentId: "user",
          timestamp,
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "The review is complete. Shared memory retains recurring decisions and unresolved work.",
              },
            ],
            api: "openai-completions",
            provider: configuration.provider,
            model: configuration.modelId,
            usage: {
              input: 100,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 120,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: 1,
          },
        },
        {
          type: "session_info",
          id: "title",
          parentId: "assistant",
          timestamp,
          name: automations[index]!.definition.name,
        },
      ];
      await writeFile(
        join(run.sessionDirectory, `2030-01-01T09-00-00-000Z_${run.sessionId}.jsonl`),
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
    }
    const memory = ManagedRuntime.make(
      makeOptMemoryLive(join(paths.cakeHome, "state"), {
        summarize: async () =>
          "Recurring review findings, completed checks, and unresolved work across Cake sessions.",
      }),
    );
    try {
      await memory.runPromise(
        Effect.flatMap(OptMemory, (memory) =>
          memory.write({
            memoryId: visualMemoryId,
            sourceSessionId: visualSessionId,
            text: "Keep recurring decisions and exact originals available. ".repeat(200),
          }),
        ),
      );
      await memory.runPromise(
        Effect.flatMap(OptMemory, (memory) =>
          memory.write({
            memoryId: visualMemoryId,
            sourceSessionId: visualSessionId,
            text: "Do not repeat open findings unless their status changes. ".repeat(200),
          }),
        ),
      );
      await memory.runPromise(
        Effect.flatMap(OptMemory, (memory) => memory.read({ memoryId: visualMemoryId })),
      );
    } finally {
      await memory.dispose();
    }
    return Object.assign(close, { requestCount: () => modelRequests });
  } catch (error) {
    await close();
    throw error;
  }
}
