import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TURN_RECOVERY_NOTICE_PART_ID, turnRetryPrompt } from "../../../src/agent/turn-recovery";
import { createCakeRuntime, type CakeRuntime } from "../../../src/agent/cake-runtime";

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
  port: number;
  requestCount(): number;
}

/** Registers a fixture openai-completions provider backed by a local SSE server. */
async function registerFixtureProvider(
  cwd: string,
  respond: (requestIndex: number, response: import("node:http").ServerResponse) => void,
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
  // SAFETY: listening on an explicit IPv4 host/port always yields an AddressInfo.
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
  return { port: address.port, requestCount: () => requests };
}

describe("turn recovery against a flaky provider", () => {
  it("retries silent empty responses with backoff until the provider recovers", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    // Two dead responses, then a healthy one — the shape observed in the wild.
    const provider = await registerFixtureProvider(directory, (requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex <= 2) {
        response.write(sseChunk({ role: "assistant" }, "stop"));
        response.end("data: [DONE]\n\n");
        return;
      }
      response.write(sseChunk({ role: "assistant", content: "Recovered answer" }));
      response.write(sseChunk({}, "stop"));
      response.end("data: [DONE]\n\n");
    });

    const onEvent = vi.fn();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir: join(directory, "sessions"),
      trusted: true,
      newSession: true,
      turnRetryBaseDelayMs: 10,
      requestUi: async () => undefined,
      onEvent,
    });
    runtimes.push(runtime);
    await runtime.setModel("fixture-provider", "fixture-model");

    const firstPrompt = runtime.prompt("Do the thing", "prompt", []);
    // The first run settles on an empty response; Cake must re-prompt twice
    // more before the provider recovers.
    await vi.waitFor(() => expect(provider.requestCount()).toBeGreaterThanOrEqual(3), {
      timeout: 5_000,
    });
    await firstPrompt;

    const recoveryNotices = onEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event?.type === "part-updated" &&
          event.part?.id === TURN_RECOVERY_NOTICE_PART_ID &&
          event.part?.kind === "notice",
      );
    expect(recoveryNotices.length).toBeGreaterThanOrEqual(2);
    expect(recoveryNotices[0]?.part?.title).toContain("attempt 1");
    expect(recoveryNotices[0]?.part?.detail).toContain("no content at all");

    // The retry prompts were injected into the conversation and the final
    // assistant answer arrived once the provider recovered.
    const transcript = await readFile((await runtime.snapshot()).sessionFile, "utf8");
    expect(transcript).toContain(turnRetryPrompt("empty"));
    expect(transcript).toContain("Recovered answer");

    // A settled substantive turn clears the recovery notice.
    expect(
      onEvent.mock.calls.some(
        ([event]) =>
          event?.type === "part-removed" && event.partId === TURN_RECOVERY_NOTICE_PART_ID,
      ),
    ).toBe(true);
  });

  it("does not schedule a retry after a user-initiated stop", async () => {
    const directory = await createTemporaryDirectory();
    const agentDir = join(directory, "agent");
    // The stream never finishes on its own; the test aborts it mid-flight.
    const provider = await registerFixtureProvider(directory, (_requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Working…" }));
      // Deliberately never ends; runtime.abort() tears the request down.
    });

    const onEvent = vi.fn();
    const runtime = await createCakeRuntime({
      cwd: directory,
      agentDir,
      sessionDir: join(directory, "sessions"),
      trusted: true,
      newSession: true,
      turnRetryBaseDelayMs: 10,
      requestUi: async () => undefined,
      onEvent,
    });
    runtimes.push(runtime);
    await runtime.setModel("fixture-provider", "fixture-model");

    const prompt = runtime.prompt("Start work", "prompt", []);
    await vi.waitFor(() => expect(provider.requestCount()).toBe(1), { timeout: 2_000 });
    await runtime.abort();
    await prompt.catch(() => undefined);

    // Give any (wrongly) scheduled retry ample time to fire; the request
    // count must stay at one and no recovery notice may appear.
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
