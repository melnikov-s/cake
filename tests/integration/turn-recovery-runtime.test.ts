import { createProjectSessionRuntime as createCakeSessionRuntime } from "../../src/layers/CakeOperations";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_RECOVERY_NOTICE_PART_ID } from "../../src/services/pi/runtime/turn-recovery";
import { type CakeSessionRuntime } from "../../src/services/pi/runtime/cake-session-runtime";

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

function sseChunk(delta: { role?: string; content?: string }, finishReason: string | null = null) {
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
}

async function registerFixtureProvider(
  cwd: string,
  respond: (requestIndex: number, response: ServerResponse) => void,
): Promise<FixtureProvider> {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    respond(requests, response);
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
  return { requestCount: () => requests };
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
        response.write(sseChunk({ role: "assistant", content: "Recovered after restart" }));
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
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
      // Opening/observing a session does not admit a turn.
      expect((await reopened.snapshot()).streaming).toBe(false);
      expect(provider.requestCount()).toBe(1);
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(2);
      await reopened.recoverInput?.(input);
      expect(provider.requestCount()).toBe(2);
      const transcript = await readFile(file, "utf8");
      expect(transcript.match(/"role":"user"/g)).toHaveLength(1);
      expect(
        (await reopened.snapshot()).parts.some(
          (part) => part.kind === "text" && part.text === "Recovered after restart",
        ),
      ).toBe(true);
    }, 15_000);
  }

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
