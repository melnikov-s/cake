import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createCakeRuntime,
  type CakeRuntime,
  type CakeRuntimeEvent,
} from "../../src/services/pi/runtime/cake-runtime";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const runtimes: CakeRuntime[] = [];

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
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

function finishTextResponse(response: ServerResponse, text: string) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(sseChunk({ role: "assistant", content: text }));
  response.write(sseChunk({}, "stop"));
  response.end("data: [DONE]\n\n");
}

async function createTemporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "cake-runtime-characterization-"));
  temporaryDirectories.push(path);
  return path;
}

async function registerFixtureProvider(
  directory: string,
  respond: (requestIndex: number, response: ServerResponse) => void,
) {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    respond(requestCount, response);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo | null;
  if (!address) throw new Error("Expected a TCP test server");
  await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "extensions", "fixture-provider.ts"),
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
  return { requestCount: () => requestCount };
}

async function createFixtureRuntime(
  directory: string,
  events: CakeRuntimeEvent[],
  options: { sessionFile?: string } = {},
) {
  const runtime = await createCakeRuntime({
    cwd: directory,
    agentDir: join(directory, "agent"),
    sessionDir: join(directory, "sessions"),
    trusted: true,
    newSession: options.sessionFile ? undefined : true,
    sessionFile: options.sessionFile,
    requestUi: async () => undefined,
    onEvent: (event) => events.push(event),
  });
  runtimes.push(runtime);
  await runtime.setModel("fixture-provider", "fixture-model");
  events.length = 0;
  return runtime;
}

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CakeRuntime characterization", () => {
  it("projects streaming text and a tool lifecycle before the settled snapshot", async () => {
    const directory = await createTemporaryDirectory();
    const finalResponseStarted = deferred();
    const releaseFinalResponse = deferred();
    await registerFixtureProvider(directory, (requestIndex, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requestIndex === 1) {
        response.write(sseChunk({ role: "assistant", content: "Inspecting." }));
        response.write(
          sseChunk({
            tool_calls: [
              {
                index: 0,
                id: "fixture-tool-call",
                type: "function",
                function: { name: "bash", arguments: '{"command":"printf tool-output"}' },
              },
            ],
          }),
        );
        response.write(sseChunk({}, "tool_calls"));
        response.end("data: [DONE]\n\n");
        return;
      }
      finalResponseStarted.resolve();
      response.write(sseChunk({ role: "assistant", content: "Finished." }));
      void releaseFinalResponse.promise.then(() => {
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    const events: CakeRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events);

    const prompt = runtime.prompt("Inspect with a tool", "prompt", []);
    await finalResponseStarted.promise;

    const liveSnapshot = await runtime.snapshot();
    expect(runtime.streaming).toBe(true);
    expect(liveSnapshot.streaming).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "streaming", sessionId: runtime.sessionId, streaming: true },
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({ kind: "text", text: "Inspecting." }),
        }),
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({
            id: "tool-fixture-tool-call",
            kind: "tool",
            name: "bash",
            input: "printf tool-output",
            state: "running",
          }),
        }),
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({
            id: "tool-fixture-tool-call",
            kind: "tool",
            output: "tool-output",
            state: "success",
          }),
        }),
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({ kind: "text", text: "Finished.", status: "streaming" }),
        }),
      ]),
    );

    releaseFinalResponse.resolve();
    await prompt;
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "streaming",
        sessionId: runtime.sessionId,
        streaming: false,
      }),
    );
    const settled = await runtime.snapshot();
    expect(settled.streaming).toBe(false);
    expect(settled.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "text", text: "Inspecting.", status: "complete" }),
        expect.objectContaining({ kind: "tool", name: "bash", state: "success" }),
        expect.objectContaining({ kind: "text", text: "Finished.", status: "complete" }),
      ]),
    );
  });

  it("queues input during compaction and flushes it after compaction settles", async () => {
    const directory = await createTemporaryDirectory();
    const compactionStarted = deferred();
    const releaseCompaction = deferred();
    await registerFixtureProvider(directory, (_requestIndex, response) =>
      finishTextResponse(response, "Queued response"),
    );
    const gate = createServer((_request, response) => {
      compactionStarted.resolve();
      void releaseCompaction.promise.then(() => {
        response.writeHead(200);
        response.end();
      });
    });
    servers.push(gate);
    await new Promise<void>((resolve, reject) => {
      gate.once("error", reject);
      gate.listen(0, "127.0.0.1", resolve);
    });
    const gateAddress = gate.address() as AddressInfo | null;
    if (!gateAddress) throw new Error("Expected a compaction gate server");
    await writeFile(
      join(directory, ".pi", "extensions", "controlled-compaction.ts"),
      `export default function (pi) {
  pi.on("session_before_compact", async (event) => {
    await fetch("http://127.0.0.1:${gateAddress.port}");
    return { compaction: { summary: "Compacted history", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
  });
}\n`,
    );

    await mkdir(join(directory, "agent"), { recursive: true });
    await writeFile(
      join(directory, "agent", "settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: 1, reserveTokens: 128 } }),
    );
    const sessionDir = cakeWorkspaceSessionDirectory(directory, join(directory, "sessions"));
    const manager = SessionManager.create(directory, sessionDir);
    manager.appendMessage({
      role: "user",
      content: "Earlier question that should be summarized",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer that should be summarized" }],
      api: "openai-completions",
      provider: "fixture-provider",
      model: "fixture-model",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    manager.appendMessage({ role: "user", content: "Existing question", timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "Existing answer" }],
      api: "openai-completions",
      provider: "fixture-provider",
      model: "fixture-model",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const events: CakeRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events, {
      sessionFile: manager.getSessionFile() ?? undefined,
    });

    const compact = runtime.compact();
    await compactionStarted.promise;
    await runtime.prompt("Run after compaction", "prompt", []);

    expect(await runtime.listQueuedMessages()).toEqual({
      steering: [],
      followUp: ["Run after compaction"],
    });
    const compacting = await runtime.snapshot();
    expect(compacting.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "active-compaction", title: "Compacting context" }),
        expect.objectContaining({ text: "Run after compaction", deliveryState: "queued" }),
      ]),
    );

    releaseCompaction.resolve();
    await compact;
    await vi.waitFor(async () => expect((await runtime.listQueuedMessages()).followUp).toEqual([]));
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "compaction", summary: "Compacted history" }),
          expect.objectContaining({ kind: "text", role: "user", text: "Run after compaction" }),
          expect.objectContaining({ kind: "text", role: "assistant", text: "Queued response" }),
        ]),
      ),
    );
  });

  it("aborts an active turn and publishes an idle snapshot without continuing", async () => {
    const directory = await createTemporaryDirectory();
    const requestStarted = deferred();
    const provider = await registerFixtureProvider(directory, (_requestIndex, response) => {
      requestStarted.resolve();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Still working" }));
    });
    const events: CakeRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events);

    const prompt = runtime.prompt("Keep working", "prompt", []);
    await requestStarted.promise;
    await vi.waitFor(() => expect(runtime.streaming).toBe(true));
    await runtime.abort();
    await prompt.catch(() => undefined);

    await vi.waitFor(() => expect(runtime.streaming).toBe(false));
    expect(provider.requestCount()).toBe(1);
    expect((await runtime.snapshot()).streaming).toBe(false);
    expect(events).toContainEqual({
      type: "streaming",
      sessionId: runtime.sessionId,
      streaming: false,
    });
  });

  it("queues reload during a turn and drains it after the turn settles", async () => {
    const directory = await createTemporaryDirectory();
    const requestStarted = deferred();
    const releaseResponse = deferred();
    await registerFixtureProvider(directory, (_requestIndex, response) => {
      requestStarted.resolve();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseChunk({ role: "assistant", content: "Before reload" }));
      void releaseResponse.promise.then(() => {
        response.write(sseChunk({}, "stop"));
        response.end("data: [DONE]\n\n");
      });
    });
    const events: CakeRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events);

    const prompt = runtime.prompt("Reload afterward", "prompt", []);
    await requestStarted.promise;
    await runtime.reload?.();
    await runtime.reload?.();

    expect((await runtime.snapshot()).piSettings?.reloadPending).toBe(true);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({ id: "pi-reload-status", title: "Pi reload queued" }),
        }),
      ]),
    );

    releaseResponse.resolve();
    await prompt;
    await vi.waitFor(async () =>
      expect((await runtime.snapshot()).piSettings?.reloadPending).toBe(false),
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({ id: "pi-reload-status", title: "Reloading Pi" }),
        }),
        { type: "part-removed", sessionId: runtime.sessionId, partId: "pi-reload-status" },
      ]),
    );
    expect(
      events.filter(
        (event) =>
          event.type === "part-updated" &&
          event.part.kind === "notice" &&
          event.part.title === "Reloading Pi",
      ),
    ).toHaveLength(1);
  });
});
