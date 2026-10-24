import { createProjectSessionRuntime as createCakeSessionRuntime } from "../../src/layers/CakeOperations";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_RECOVERY_NOTICE_PART_ID } from "../../src/services/pi/runtime/turn-recovery";
import {
  type CakeSessionRuntime,
  type CakeSessionRuntimeEvent,
} from "../../src/services/pi/runtime/cake-session-runtime";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiPart } from "../../src/contracts/conversations/session-contract";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const runtimes: CakeSessionRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-turn-recovery-"));
  temporaryDirectories.push(path);
  return path;
}

function sseChunk(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({
    id: "fixture-completion",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: "fixture-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

interface FixtureProvider {
  requestCount(): number;
  requestBodies(): readonly string[];
}

async function registerFixtureProvider(
  cwd: string,
  respond: (requestIndex: number, response: ServerResponse) => void,
): Promise<FixtureProvider> {
  let requests = 0;
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (data: Buffer) => {
      body += data.toString();
    });
    request.on("end", () => {
      bodies.push(body);
      requests += 1;
      respond(requests, response);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Expected a TCP test server");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "extensions", "fixture-provider.ts"),
    `export default function (pi) { pi.registerProvider("fixture-provider", ${JSON.stringify({
      name: "Fixture provider",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture",
      api: "openai-completions",
      models: [
        {
          id: "fixture-model",
          name: "Fixture model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4_096,
          maxTokens: 1_024,
        },
      ],
    })}); }\n`,
  );
  return { requestCount: () => requests, requestBodies: () => bodies };
}

async function createFixtureRuntime(directory: string, onEvent = vi.fn()) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  const runtime = await createCakeSessionRuntime({
    cwd: directory,
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    trusted: true,
    newSession: true,
    requestUi: async () => undefined,
    onEvent,
  });
  runtimes.push(runtime);
  await runtime.setModel("fixture-provider", "fixture-model");
  return { runtime, onEvent };
}

describe("response retry and recovery", () => {
  it.each(["prompt", "pending recovery"] as const)(
    "preserves typed Workboard provenance through %s, live projection and Pi reload without hiding genuine user text",
    async (admission) => {
      const directory = await createTemporaryDirectory();
      const provider = await registerFixtureProvider(directory, (_index, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sseChunk({ role: "assistant", content: "Noted." }));
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
      const events: CakeSessionRuntimeEvent[] = [];
      const { runtime } = await createFixtureRuntime(
        directory,
        vi.fn((event: CakeSessionRuntimeEvent) => events.push(event)),
      );
      const input = {
        turnId: "internal-wake",
        delivery: "follow-up" as const,
        text: "<system-reminder>\nWorkboard delivery (family-board-private): entries #3. Read exact sources with boards.read.\n</system-reminder>",
        attachments: [],
        markdown: false,
        internal: {
          _tag: "WorkboardDelivery" as const,
          boardId: "family-board-private",
          sequences: [3],
        },
      };
      if (admission === "prompt")
        await runtime.prompt(
          input.text,
          input.delivery,
          [],
          false,
          input.turnId,
          undefined,
          false,
          undefined,
          input.internal,
        );
      else await runtime.recoverInput?.(input);
      expect(provider.requestCount()).toBe(1);
      const parts = (await runtime.snapshot()).parts;
      expect(parts.some((part) => part.kind === "context" && part.title === "Workboard")).toBe(
        true,
      );
      expect(parts.filter((part) => part.kind === "text" && part.role === "user")).toEqual([]);
      expect(
        events.flatMap((event) =>
          event.type === "part-updated" && event.part.kind === "text" && event.part.role === "user"
            ? [event.part]
            : [],
        ),
      ).toEqual([]);
      expect(runtime.hasConsumedInput?.(input.turnId)).toBe(true);
      const stored = SessionManager.open(runtime.sessionFile).getBranch();
      expect(stored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: expect.arrayContaining([
                expect.objectContaining({ type: "text", text: input.text }),
              ]),
            }),
          }),
        ]),
      );
      await runtime.dispose();
      const reopened = await createCakeSessionRuntime({
        cwd: directory,
        agentDir: join(directory, "agent"),
        sessionDir: join(directory, "sessions"),
        sessionId: runtime.sessionId,
        trusted: true,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      runtimes.push(reopened);
      const restored = (await reopened.snapshot()).parts;
      expect(
        restored.find((part) => part.kind === "context" && part.title === "Workboard"),
      ).toEqual(parts.find((part) => part.kind === "context" && part.title === "Workboard"));
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(1);
      await reopened.prompt(input.text, "prompt", [], false, "genuine-user-quote");
      expect(
        (await reopened.snapshot()).parts.filter(
          (part) => part.kind === "text" && part.role === "user",
        ),
      ).toEqual([expect.objectContaining({ text: input.text })]);
      expect(provider.requestCount()).toBe(2);
    },
  );
  for (const shutdown of ["clean quit", "crash"] as const) {
    it(`recovers ${shutdown} once from the saved Pi branch without duplicating the user input`, async () => {
      const directory = await createTemporaryDirectory();
      let signalStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const provider = await registerFixtureProvider(directory, (index, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (index === 1) {
          response.write(sseChunk({ role: "assistant", content: "Working" }));
          signalStarted();
          return;
        }
        if (index === 2) {
          response.write(
            sseChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "restart-read",
                  type: "function",
                  function: { name: "read", arguments: JSON.stringify({ path: "AGENTS.md" }) },
                },
              ],
            }),
          );
          response.write(sseChunk({}, "tool_calls"));
          response.end("data: [DONE]\n\n");
          return;
        }
        response.write(sseChunk({ role: "assistant", content: "Recovered after restart" }));
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
      await writeFile(join(directory, "AGENTS.md"), "Keep real project instructions");
      const { runtime } = await createFixtureRuntime(directory);
      const input = {
        turnId: "restart-turn",
        text: "Original assignment",
        delivery: "prompt" as const,
        attachments: [],
        markdown: false,
      };
      const running = runtime
        .prompt(input.text, input.delivery, [], false, input.turnId)
        .catch(() => undefined);
      await started;
      const file = runtime.sessionFile;
      const crashCheckpoint = await readFile(file, "utf8");
      await runtime.dispose();
      await running;
      // An abrupt process exit cannot append the graceful SDK abort message.
      if (shutdown === "crash") await writeFile(file, crashCheckpoint);
      const recoveryEvents: CakeSessionRuntimeEvent[] = [];
      const reopenOptions = {
        cwd: directory,
        agentDir: join(directory, "agent"),
        sessionDir: join(directory, "sessions"),
        sessionId: runtime.sessionId,
        trusted: true,
        requestUi: async () => undefined,
        onEvent: (event: CakeSessionRuntimeEvent) => recoveryEvents.push(event),
      };
      const reopened = await createCakeSessionRuntime(reopenOptions);
      runtimes.push(reopened);
      // Opening/observing a session does not admit a turn.
      expect((await reopened.snapshot()).streaming).toBe(false);
      expect(provider.requestCount()).toBe(1);
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(3);
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(3);
      const transcript = await readFile(file, "utf8");
      // Pi 1.2+ runs before_agent_start for custom recovery too, retaining
      // Cake instructions without a spurious default-docs delta.
      const branch = SessionManager.open(file).getBranch();
      const systemMessages = branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "system" ? [entry.message] : [],
      );
      expect(systemMessages).toHaveLength(1);
      expect(systemMessages[0]!.sections?.docs).not.toContain("docs/tui.md");
      const recovery = branch.find(
        (entry) => entry.type === "custom_message" && entry.customType === "cake.restart-recovery",
      );
      expect(recovery).toMatchObject({ display: false });
      expect(
        recoveryEvents.filter(
          (event) =>
            event.type === "part-updated" &&
            event.part.kind === "context" &&
            !event.part.id.startsWith("runtime-system-prompt-"),
        ),
      ).toEqual([]);
      const snapshot = await reopened.snapshot();
      expect(
        snapshot.parts.filter(
          (part) => part.kind === "context" && !part.id.startsWith("runtime-system-prompt-"),
        ),
      ).toEqual([]);
      expect(snapshot.parts).toContainEqual(
        expect.objectContaining({ kind: "tool", name: "read", state: "success" }),
      );
      const browse = JSON.stringify(await reopened.inspectSession({ kind: "context-outline" }));
      expect(browse).toContain("docs/sdk.md");
      expect(browse).toContain("Keep real project instructions");
      if (recovery?.type !== "custom_message") throw new Error("Missing Pi recovery message");
      expect(browse).toContain(JSON.stringify(recovery.content).slice(1, -1));
      await reopened.dispose();
      const observedAgain = await createCakeSessionRuntime(reopenOptions);
      runtimes.push(observedAgain);
      expect((await observedAgain.snapshot()).parts).toEqual(snapshot.parts);
      expect(provider.requestCount()).toBe(3);
      expect(transcript.match(/"role":"user"/g)).toHaveLength(1);
      expect(
        snapshot.parts.some(
          (part) => part.kind === "text" && part.text === "Recovered after restart",
        ),
      ).toBe(true);
    }, 15_000);
  }

  it.each(["restart", "manual Continue"] as const)(
    "hands unfinished tool effects to the agent on %s without replaying the tool or blocking on user review",
    async (continuation) => {
      const directory = await createTemporaryDirectory();
      const provider = await registerFixtureProvider(directory, (index, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (index === 1) {
          response.write(
            sseChunk({
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "uncertain-call",
                  type: "function",
                  function: {
                    name: "uncertain_mutation",
                    arguments: JSON.stringify({ value: "changed" }),
                  },
                },
              ],
            }),
          );
          response.write(sseChunk({}, "tool_calls"));
        } else {
          response.write(sseChunk({ role: "assistant", content: "Checked current state" }));
          response.write(sseChunk({}, "stop"));
        }
        response.end("data: [DONE]\n\n");
      });
      await writeFile(
        join(directory, ".pi", "extensions", "mutation.ts"),
        `import { appendFileSync } from "node:fs";
        export default function(pi) {
          pi.registerTool({ name: "uncertain_mutation", label: "Mutation", description: "Changes a file", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            execute: async () => { appendFileSync(${JSON.stringify(join(directory, "effects"))}, "1"); return { content: [{ type: "text", text: "changed" }] }; } });
        }`,
      );
      const { runtime } = await createFixtureRuntime(directory);
      const input = {
        turnId: "uncertain-turn",
        text: "Do the work",
        delivery: "prompt" as const,
        attachments: [],
        markdown: false,
      };
      await runtime.prompt(input.text, "prompt", [], false, input.turnId);
      expect(await readFile(join(directory, "effects"), "utf8")).toBe("1");
      const file = runtime.sessionFile;
      const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
      const callIndex = lines.findIndex(
        (line) => line.includes('"type":"toolCall"') && line.includes("uncertain-call"),
      );
      expect(callIndex).toBeGreaterThan(0);
      await runtime.dispose();
      // Checkpoint after the real side effect but before its result was saved.
      await writeFile(file, lines.slice(0, callIndex + 1).join("\n") + "\n");
      const events: CakeSessionRuntimeEvent[] = [];
      const reopened = await createCakeSessionRuntime({
        cwd: directory,
        agentDir: join(directory, "agent"),
        sessionDir: join(directory, "sessions"),
        sessionId: runtime.sessionId,
        trusted: true,
        requestUi: async () => undefined,
        onEvent: (event) => events.push(event),
      });
      runtimes.push(reopened);
      expect(provider.requestCount()).toBe(2);
      if (continuation === "restart") await reopened.recoverInput?.(input);
      else await reopened.prompt("Continue", "prompt", [], false, "manual-continue");
      expect(provider.requestCount()).toBe(3);
      const context = provider.requestBodies()[2];
      expect(context).toContain("uncertain_mutation");
      expect(context).toContain("uncertain-call");
      expect(context).toContain("no saved result");
      expect(context).toContain("Inspect current state and verify effects");
      expect(context).toContain("do not blindly replay");
      expect(context).toContain("ask only the concrete question");
      expect(await readFile(join(directory, "effects"), "utf8")).toBe("1");
      const snapshot = await reopened.snapshot();
      expect(snapshot.streaming).toBe(false);
      expect(snapshot.parts).toContainEqual(
        expect.objectContaining({ kind: "text", role: "assistant", text: "Checked current state" }),
      );
      expect(
        events.some(
          (event) =>
            event.type === "part-updated" &&
            event.part.kind === "notice" &&
            event.part.tone === "error",
        ),
      ).toBe(false);
      expect(snapshot.parts.some((part) => part.kind === "notice" && part.tone === "error")).toBe(
        false,
      );
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(3);
    },
    15_000,
  );

  it.each(["!echo mutate", "/mutating-command"])(
    "lets the agent inspect an interrupted command (%s) rather than executing it automatically",
    async (command) => {
      const directory = await createTemporaryDirectory();
      const provider = await registerFixtureProvider(directory, (_index, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sseChunk({ role: "assistant", content: "Inspected command outcome" }));
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
      const { runtime } = await createFixtureRuntime(directory);
      const input = {
        turnId: "command-turn",
        text: command,
        delivery: "prompt" as const,
        attachments: [],
        markdown: false,
      };
      await runtime.recoverInput?.(input);
      expect(provider.requestCount()).toBe(1);
      expect(provider.requestBodies()[0]).toContain("effects are uncertain");
      expect(provider.requestBodies()[0]).toContain(command);
      expect((await runtime.snapshot()).parts).toContainEqual(
        expect.objectContaining({
          kind: "text",
          role: "assistant",
          text: "Inspected command outcome",
        }),
      );
      await runtime.recoverInput?.(input);
      expect(provider.requestCount()).toBe(1);
    },
  );

  it("keeps a busy parent's worker report unacknowledged until Pi persists it and retries once after a crash", async () => {
    const directory = await createTemporaryDirectory();
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const provider = await registerFixtureProvider(directory, (index, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        sseChunk({ role: "assistant", content: index === 1 ? "Busy" : "Report received" }),
      );
      if (index === 1) started();
      else {
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      }
    });
    const { runtime } = await createFixtureRuntime(directory);
    const running = runtime
      .prompt("Parent work", "prompt", [], false, "parent-turn")
      .catch(() => undefined);
    await ready;
    const completionId = "c3c0aba9-e0ba-496a-96a5-60be562db027";
    const report = {
      handleId: "1490b261-4ce9-4744-b0fb-f2d013787ff1",
      task: "Linked prerequisite",
      status: "complete",
      resolvedModel: {
        requested: "current",
        source: "current",
        provider: "fixture-provider",
        modelId: "fixture-model",
        thinkingLevel: "off",
        fallbacks: [],
      },
      fastMode: false,
      streaming: false,
      parts: [
        {
          id: "result",
          kind: "text",
          role: "assistant",
          status: "complete",
          text: "[Commit](cake://session/worker?message=commit)",
        },
      ],
    };
    let acknowledged = false;
    const delivery = runtime.notifySubagentCompletion?.(report, completionId).then(() => {
      acknowledged = true;
    });
    const checkpoint = await readFile(runtime.sessionFile, "utf8");
    expect(acknowledged).toBe(false);
    expect(checkpoint).not.toContain(completionId);
    const rejected = expect(delivery).rejects.toThrow("before the worker report was persisted");
    await runtime.dispose();
    await Promise.all([running, rejected]);
    await writeFile(runtime.sessionFile, checkpoint);
    const reopened = await createCakeSessionRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      sessionId: runtime.sessionId,
      trusted: true,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(reopened);
    await reopened.notifySubagentCompletion?.(report, completionId);
    expect(provider.requestCount()).toBe(2);
    await reopened.notifySubagentCompletion?.(report, completionId);
    expect(provider.requestCount()).toBe(2);
    const persisted = await readFile(reopened.sessionFile, "utf8");
    expect(persisted.match(/cake.subagent-completion/g)).toHaveLength(1);

    // A failed append can leave Pi's entry index ahead of its file. An indexed
    // receipt without its persisted line must not suppress the durable retry.
    await writeFile(
      reopened.sessionFile,
      persisted
        .split("\n")
        .filter((line) => !line.includes(completionId))
        .join("\n"),
    );
    await reopened.notifySubagentCompletion?.(report, completionId);
    expect(provider.requestCount()).toBe(3);
    expect(
      (await readFile(reopened.sessionFile, "utf8")).match(/cake.subagent-completion/g),
    ).toHaveLength(1);
  }, 15_000);

  it("settles correlated follow-up input only after Pi consumes it", async () => {
    const directory = await createTemporaryDirectory();
    let started: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finishFirst: () => void = () => {
      throw new Error("First request has not started");
    };
    const provider = await registerFixtureProvider(directory, (index, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: index === 1 ? "First" : "Second" }));
      const finish = () => {
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      };
      if (index === 1) {
        finishFirst = finish;
        started();
      } else finish();
    });
    const { runtime } = await createFixtureRuntime(directory);
    const first = runtime.prompt("First assignment", "prompt", [], false, "first-turn");
    await firstStarted;
    let settled = false;
    const second = runtime
      .prompt("Second assignment", "follow-up", [], false, "second-turn")
      .then(() => {
        settled = true;
      });
    await vi.waitFor(async () =>
      expect((await runtime.listQueuedMessages()).followUp).toHaveLength(1),
    );
    expect(settled).toBe(false);
    expect(runtime.executingTurnIds?.()).toEqual(["first-turn"]);
    finishFirst();
    await Promise.all([first, second]);
    expect(provider.requestCount()).toBe(2);
    expect(settled).toBe(true);
    expect(runtime.executingTurnIds?.()).toEqual([]);
  });

  it("leaves provider errors to Pi and removes intermediate retry messages", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (requestIndex, response) => {
      if (requestIndex === 1) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "503 Service Unavailable", type: "server_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Recovered natively" }));
      response.write(sseChunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);

    await runtime.prompt("Do the thing", "prompt", []);

    expect(provider.requestCount()).toBe(2);
    const snapshot = await runtime.snapshot();
    const transcript = await readFile(snapshot.sessionFile, "utf8");
    expect(transcript).not.toContain('"customType":"cake.turn-recovery"');
    expect(
      onEvent.mock.calls.some(
        ([event]) => event?.type === "part-updated" && event.part?.title === "Model request failed",
      ),
    ).toBe(false);
    expect(
      snapshot.parts.some(
        (part) => part.kind === "notice" && part.title === "Model request failed",
      ),
    ).toBe(false);
    expect(
      onEvent.mock.calls.some(
        ([event]) => event?.type === "part-removed" && event.partId === "active-retry",
      ),
    ).toBe(true);
  }, 10_000);

  it("retries an empty 429 through Cake without persisting the failed attempt", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (requestIndex, response) => {
      if (requestIndex === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "429 Too Many Requests" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Recovered from throttling" }));
      response.write(sseChunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);

    await runtime.prompt("Do the thing", "prompt", []);

    expect(provider.requestCount()).toBe(2);
    expect(
      onEvent.mock.calls.some(
        ([event]) =>
          event?.type === "part-updated" &&
          event.part?.id === "active-retry" &&
          event.part.title === "Retry 1/32",
      ),
    ).toBe(true);
    const transcript = await readFile((await runtime.snapshot()).sessionFile, "utf8");
    expect(transcript).toContain("Recovered from throttling");
    expect(transcript).not.toContain("429 Too Many Requests");
  });

  it("shows the next retry time and lets Stop cancel the pending retry", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (_requestIndex, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "429 Too Many Requests" } }));
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);

    const prompt = runtime.prompt("Do the thing", "prompt", []);
    await vi.waitFor(() =>
      expect(
        onEvent.mock.calls.some(
          ([event]) =>
            event?.type === "part-updated" &&
            event.part?.id === "active-retry" &&
            event.part.title === "Retry 1/32" &&
            Boolean(event.part.detail) &&
            typeof event.part.retryAt === "number" &&
            Number.isFinite(event.part.retryAt),
        ),
      ).toBe(true),
    );
    await runtime.abort();
    await prompt;

    expect(provider.requestCount()).toBe(1);
    expect(
      onEvent.mock.calls.some(
        ([event]) => event?.type === "part-removed" && event.partId === "active-retry",
      ),
    ).toBe(true);
    expect((await runtime.snapshot()).streaming).toBe(false);
  });

  it("retries a well-formed empty response with backoff without persisting it", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 1) response.write(sseChunk({ role: "assistant" }, "stop"));
      else response.write(sseChunk({ role: "assistant", content: "Recovered" }, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);

    await runtime.prompt("Do the thing", "prompt", []);

    expect(provider.requestCount()).toBe(2);
    expect(
      onEvent.mock.calls.some(
        ([event]) =>
          event?.type === "part-updated" &&
          event.part?.id === "active-retry" &&
          event.part.detail?.includes("The provider returned an empty response"),
      ),
    ).toBe(true);
    const transcript = await readFile((await runtime.snapshot()).sessionFile, "utf8");
    expect(transcript).toContain("Recovered");
    expect(transcript).not.toContain("cake.turn-recovery");
  });

  it("obeys the Automatic retry setting", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (_requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant" }, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const { runtime } = await createFixtureRuntime(directory);
    await runtime.setPiSetting({ key: "retryEnabled", value: false });

    await runtime.prompt("Do the thing", "prompt", []);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(provider.requestCount()).toBe(1);
  });

  it("does not continue after a user-initiated stop", async () => {
    const directory = await createTemporaryDirectory();
    const provider = await registerFixtureProvider(directory, (_requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Working…" }));
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);

    const prompt = runtime.prompt("Start work", "prompt", []);
    await vi.waitFor(() => expect(provider.requestCount()).toBe(1), { timeout: 2_000 });
    await runtime.abort();
    await prompt.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(provider.requestCount()).toBe(1);
    expect(
      onEvent.mock.calls.filter(
        ([event]) =>
          event?.type === "part-updated" && event.part?.id === TURN_RECOVERY_NOTICE_PART_ID,
      ),
    ).toEqual([]);
  });
});

describe("send-now handoff presentation", () => {
  const failures = (parts: readonly UiPart[]) =>
    parts.flatMap((part) =>
      part.kind === "notice" && part.title === "Model request failed" ? [part.detail] : [],
    );

  /** Starts a turn whose bash tool is still running, the window where Pi's abort surfaces as an `error` stop. */
  async function runningTool(replacement: "answers" | "fails") {
    const directory = await createTemporaryDirectory();
    await registerFixtureProvider(directory, (index, response) => {
      if (index === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          sseChunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_sleep",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) },
              },
            ],
          }),
        );
        response.write(sseChunk({}, "tool_calls"));
        response.end("data: [DONE]\n\n");
        return;
      }
      if (replacement === "fails") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "Invalid fixture request" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Replacement done." }));
      response.write(sseChunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });
    const { runtime, onEvent } = await createFixtureRuntime(directory);
    const active = runtime.prompt("Start work", "prompt", []).catch((error: unknown) => error);
    await vi.waitFor(
      async () =>
        expect(
          (await runtime.snapshot()).parts.some(
            (part) => part.kind === "tool" && part.state === "running",
          ),
        ).toBe(true),
      { timeout: 5_000 },
    );
    return { directory, runtime, onEvent, active };
  }

  async function sendNow(runtime: CakeSessionRuntime) {
    const replacement = runtime.prompt("Replacement", "follow-up", []).catch(() => undefined);
    let queuedId = "";
    await vi.waitFor(async () => {
      const queued = (await runtime.snapshot()).parts.find(
        (part) => part.kind === "text" && part.deliveryState === "queued",
      );
      expect(queued).toBeDefined();
      queuedId = queued!.id;
    });
    await runtime.sendQueuedMessageNow(queuedId);
    await replacement;
  }

  it("hides the aborted request a send-now replaced, live and after reopen", async () => {
    const { directory, runtime, onEvent, active } = await runningTool("answers");
    await sendNow(runtime);
    await active;

    const stored = SessionManager.open(runtime.sessionFile).getBranch();
    // The abort reached Pi's next request and surfaced as an `error` stop, not `aborted`.
    expect(stored).toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ role: "assistant", stopReason: "error" }),
      }),
    );
    const parts = (await runtime.snapshot()).parts;
    expect(failures(parts)).toEqual([]);
    expect(parts.filter((part) => part.kind === "text").map((part) => part.text)).toEqual([
      "Start work",
      "Replacement",
      "Replacement done.",
    ]);
    expect(
      onEvent.mock.calls.some(
        ([event]) => event?.type === "part-updated" && event.part?.title === "Model request failed",
      ),
    ).toBe(false);

    await runtime.dispose();
    const reopened = await createCakeSessionRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      sessionDir: join(directory, "sessions"),
      sessionId: runtime.sessionId,
      trusted: true,
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    runtimes.push(reopened);
    expect(failures((await reopened.snapshot()).parts)).toEqual([]);
  }, 15_000);

  it("keeps showing the aborted request after an explicit Stop", async () => {
    const { runtime, active } = await runningTool("answers");
    await runtime.abort({ by: "user" });
    await active;
    expect(failures((await runtime.snapshot()).parts)).toEqual(["This operation was aborted"]);
  }, 15_000);

  it("still shows a genuine provider error from the replacement request", async () => {
    const { runtime, active } = await runningTool("fails");
    await sendNow(runtime);
    await active;
    const shown = failures((await runtime.snapshot()).parts);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain("Invalid fixture request");
  }, 15_000);
});
