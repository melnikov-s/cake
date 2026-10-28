import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import type { ConversationSnapshot } from "../../src/contracts/conversations/session-contract";
import {
  subagentCompletionMessage,
  subagentFinalAnswerPart,
} from "../../src/contracts/subagents/subagent-report";
import * as subagents from "../../src/domain/subagents/subagents";
import { createProjectSessionRuntime } from "../../src/layers/CakeOperations";
import { makeCakeSessionRuntimesLayer } from "../../src/services/pi/CakeSessionRuntimes";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { SubagentCoordinatorLive } from "../../src/services/subagents/SubagentCoordinator";
import { makeSubagentEnvironmentLayer } from "../../src/services/subagents/SubagentEnvironment";
import { familyStorageHarness } from "../app/helpers/familyStorageHarness";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  snapshot,
} from "../app/helpers/piRuntimeFixture";
import { makeSubagentStorageTestLayer } from "../app/helpers/subagentStorageFixture";

/**
 * A real Pi worker runtime, assembled exactly as `subagents.run` assembles it, against a
 * local OpenAI-compatible model. The user's saved Pi settings turn auto-compaction off.
 */
const CONTEXT_WINDOW = 4_096;
const NARRATION = "Now let me set up the project folder structure.";
const FINAL_REPORT = "Final report: the explainer site is built and every chart renders.";

const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

type Reply =
  | { kind: "text"; text: string; finish: "stop" | "length"; promptTokens: number }
  | { kind: "tool"; text: string; promptTokens: number };

function respond(response: ServerResponse, reply: Reply) {
  const chunk = (delta: object, finish: string | null = null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "fixture",
      object: "chat.completion.chunk",
      created: 0,
      model: "fixture-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : null),
    })}\n\n`;
  const usage = { prompt_tokens: reply.promptTokens, completion_tokens: 40 };
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(chunk({ role: "assistant", content: reply.text }));
  if (reply.kind === "tool") {
    response.write(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call-read-notes",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
          },
        ],
      }),
    );
    response.write(chunk({}, "tool_calls", usage));
  } else response.write(chunk({}, reply.finish, usage));
  response.end("data: [DONE]\n\n");
}

/** Answers summarization requests itself; `work` answers the worker's own requests. */
async function setUp(work: (afterTool: boolean) => Reply) {
  const root = await mkdtemp(join(tmpdir(), "cake-subagent-context-"));
  directories.push(root);
  const project = join(root, "project");
  const agentDirectory = join(root, "agent");
  const sessionDirectory = join(root, "subagent-sessions");
  await mkdir(join(agentDirectory, "extensions"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.txt"), "Effort levels: low, medium, high.\n");
  const requests = { summaries: 0, work: 0 };
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      if (body.includes("context summarization assistant")) {
        requests.summaries += 1;
        respond(response, {
          kind: "text",
          text: "## Goal\nBuild the explainer site.\n## Progress\nRead the notes.",
          finish: "stop",
          promptTokens: 300,
        });
        return;
      }
      requests.work += 1;
      const messages = (JSON.parse(body) as { messages?: Array<{ role?: string }> }).messages;
      respond(response, work(Boolean(messages?.some((message) => message.role === "tool"))));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // Workers load no extensions; the agent directory's providers still apply.
  await writeFile(
    join(agentDirectory, "extensions", "fixture-provider.ts"),
    `export default function (pi) { pi.registerProvider("fixture-provider", ${JSON.stringify({
      name: "Fixture provider",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "fixture",
      api: "openai-completions",
      models: [
        {
          id: "fixture-model",
          name: "Fixture model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: CONTEXT_WINDOW,
          maxTokens: 1_024,
        },
      ],
    })}); }\n`,
  );
  await writeFile(
    join(agentDirectory, "settings.json"),
    JSON.stringify({ compaction: { enabled: false, reserveTokens: 512, keepRecentTokens: 1 } }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);

  const parentSnapshot: ConversationSnapshot = {
    ...snapshot,
    workspacePath: project,
    model: { provider: "fixture-provider", id: "fixture-model", name: "Fixture model" },
    models: [
      {
        provider: "fixture-provider",
        providerName: "Fixture provider",
        id: "fixture-model",
        name: "Fixture model",
        reasoning: false,
        availableThinkingLevels: ["off"],
        fastMode: false,
        input: ["text"],
        authenticated: true,
        available: true,
        authTypes: [],
      },
    ],
  };
  const application = Layer.effect(
    ApplicationState,
    Effect.gen(function* () {
      const value = {
        ...defaultApplicationState(),
        trustedProjectPaths: [project],
        projects: [{ path: project, name: "project", addedAt: "now", lastOpenedAt: "now" }],
      };
      const projection = yield* SubscriptionRef.make({ revision: 0, state: value });
      return ApplicationState.of({
        initialize: () => Effect.succeed(value),
        current: () => SubscriptionRef.get(projection).pipe(Effect.map((item) => item.state)),
        snapshot: () => SubscriptionRef.getUnsafe(projection).state,
        changes: () => SubscriptionRef.changes(projection),
        transact: () => Effect.die("Unexpected application transaction"),
      });
    }),
  );
  const layer = Layer.mergeAll(
    application,
    makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (options) =>
        options.auxiliary
          ? Effect.tryPromise(() => createProjectSessionRuntime(options))
          : Effect.succeed({
              ...fakeRuntime(options, () => undefined),
              snapshot: async () => parentSnapshot,
            }),
    }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    familyStorageHarness().layer,
    makeSubagentEnvironmentLayer({
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory: workingDirectory ?? project,
          agentDirectory,
          sessionDirectory,
          trusted: true,
        }),
    }),
  );
  const parent: subagents.SubagentParentRuntime = {
    parentSessionId: "parent",
    workingDirectory: project,
    options: {
      profile: { _tag: "ProjectSession" },
      runtime: {
        cwd: project,
        trusted: true,
        agentDir: agentDirectory,
        sessionDir: join(root, "sessions"),
        sessionId: "parent",
        requestUi: async () => undefined,
      },
    },
    runEffect: (effect) => Effect.runPromise(effect),
  };
  const run = () =>
    Effect.runPromise(
      Effect.scoped(
        subagents
          .run({ task: "Build the paper explainer site", continuation: "none" }, parent)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(subagents.SubagentResult)),
            Effect.provide(layer),
          ),
      ),
    );
  return { run, requests, sessionDirectory };
}

/** Compaction entries Pi appended to the worker's own JSONL history. */
const compactionEntries = async (sessionDirectory: string) => {
  const files = await readdir(sessionDirectory, { recursive: true });
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) =>
        (await readFile(join(sessionDirectory, file), "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { type: string }),
      ),
  );
  return entries.flat().filter((entry) => entry.type === "compaction");
};

describe("subagent context limit", () => {
  it("auto-compacts when the worker crosses its threshold and continues to a final report", async () => {
    const fixture = await setUp((afterTool) =>
      afterTool
        ? { kind: "text", text: FINAL_REPORT, finish: "stop", promptTokens: 400 }
        : // 3,740 of 4,096 tokens: past the 3,584-token threshold before the next response.
          { kind: "tool", text: NARRATION, promptTokens: 3_700 },
    );
    const result = await fixture.run();
    expect(result.status).toBe("complete");
    expect(subagentFinalAnswerPart(result)?.text).toBe(FINAL_REPORT);
    expect(fixture.requests.summaries).toBeGreaterThan(0);
    expect(fixture.requests.work).toBe(2);
    expect(await compactionEntries(fixture.sessionDirectory)).toHaveLength(1);
  });

  it("ends as an error with a context-exhausted reason when compaction cannot make room", async () => {
    const fixture = await setUp((afterTool) =>
      afterTool
        ? // Every response, including Pi's retry after compacting, is cut off at the window.
          { kind: "text", text: "", finish: "length", promptTokens: 4_000 }
        : { kind: "tool", text: NARRATION, promptTokens: 300 },
    );
    const result = await fixture.run();
    expect(fixture.requests.summaries).toBeGreaterThan(0);
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "Context exhausted: 4,040 of 4,096 context tokens were in use, so the response was cut off before it finished.",
    );
    expect(subagentCompletionMessage(result)).toBe(
      `Background subagent error: Build the paper explainer site\n\n${result.error}`,
    );
  });
});
