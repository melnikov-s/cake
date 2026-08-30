import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_RECOVERY_NOTICE_PART_ID } from "../../src/agent/turn-recovery";
import { createCakeRuntime, type CakeRuntime } from "../../src/agent/cake-runtime";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const runtimes: CakeRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
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
  const runtime = await createCakeRuntime({
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
