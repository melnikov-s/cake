import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  type AgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { resolveCakePaths } from "../../src/config/CakePaths";
import { piAgentDirectory } from "../../src/services/pi/PiPaths";
import {
  createCakeSessionRuntime,
  type CakeSessionRuntime,
  type CakeSessionRuntimeEvent,
} from "../../src/services/pi/runtime/cake-session-runtime";
import { cakeWorkspaceSessionDirectory } from "../../src/services/pi/runtime/session-discovery";

const temporaryDirectories: string[] = [];
const servers: Server[] = [];
const runtimes: CakeSessionRuntime[] = [];
const nativeSessions: AgentSession[] = [];

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
  const path = await mkdtemp(join(tmpdir(), "cake-session-runtime-characterization-"));
  temporaryDirectories.push(path);
  return path;
}

async function registerFixtureProvider(
  directory: string,
  respond: (requestIndex: number, response: ServerResponse) => void,
  observeRequest?: (body: Record<string, unknown>) => void,
) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      observeRequest?.(JSON.parse(body) as Record<string, unknown>);
      requestCount += 1;
      respond(requestCount, response);
    });
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
  events: CakeSessionRuntimeEvent[],
  options: { sessionFile?: string } = {},
) {
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  const runtime = await createCakeSessionRuntime({
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
  for (const session of nativeSessions.splice(0)) session.dispose();
  vi.unstubAllEnvs();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("CakeSessionRuntime characterization", () => {
  it("retains required system instructions across Tool Compact without re-emitting an unchanged system message", async () => {
    const directory = await createTemporaryDirectory();
    const bodies: Array<Record<string, unknown>> = [];
    await registerFixtureProvider(
      directory,
      (index, response) => finishTextResponse(response, `Reply ${index}`),
      (body) => bodies.push(body),
    );
    await mkdir(join(directory, "agent"), { recursive: true });
    await writeFile(
      join(directory, "agent", "settings.json"),
      JSON.stringify({
        compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 },
      }),
    );
    await writeFile(join(directory, ".pi", "APPEND_SYSTEM.md"), "REQUIRED_CANONICAL_INSTRUCTION");
    await writeFile(
      join(directory, ".pi", "extensions", "compaction.ts"),
      `export default function (pi) {
      pi.on("session_before_compact", (event) => ({ compaction: {
        summary: "Fixed summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } }));
    }`,
    );
    const events: CakeSessionRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events);
    const systemEntries = () =>
      SessionManager.open(runtime.sessionFile)
        .getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "system");
    const injections = () =>
      events.filter(
        (event) =>
          event.type === "part-updated" &&
          event.part.kind === "context" &&
          event.part.title === "System message",
      );
    const requestSystems = (body: Record<string, unknown>) =>
      (body.messages as Array<{ role: string; content: string }>).filter(
        (message) => message.role === "system",
      );

    await runtime.prompt("First", "prompt", []);
    const before = await runtime.snapshot();
    const selectedId = SessionManager.open(runtime.sessionFile)
      .getBranch()
      .findLast((entry) => entry.type === "message" && entry.message.role === "assistant")!.id;
    expect(systemEntries()).toHaveLength(1);
    events.length = 0;
    await runtime.toolCompact(selectedId);
    const compacted = await runtime.snapshot();
    expect(compacted.parts.filter((part) => part.kind === "context")).toHaveLength(
      before.parts.filter((part) => part.kind === "context").length,
    );
    expect(injections()).toHaveLength(0);
    expect(systemEntries()).toHaveLength(1);
    await runtime.prompt("Continue", "prompt", []);
    await runtime.prompt("Continue again", "prompt", []);
    expect(injections()).toHaveLength(0);
    expect(systemEntries()).toHaveLength(1);
    expect(requestSystems(bodies[0]!)[0]!.content).toContain("REQUIRED_CANONICAL_INSTRUCTION");
    expect(requestSystems(bodies[1]!)).toEqual(requestSystems(bodies[0]!));
    expect(requestSystems(bodies[2]!)).toEqual(requestSystems(bodies[0]!));

    events.length = 0;
    await runtime.compact();
    await runtime.prompt("After manual compaction", "prompt", []);
    expect(injections()).toHaveLength(0);
    expect(requestSystems(bodies[3]!)).toEqual(requestSystems(bodies[0]!));

    await runtime.setPiSetting({ key: "autoCompact", value: true });
    events.length = 0;
    await runtime.prompt("After enabling automatic compaction", "prompt", []);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "part-updated",
        part: expect.objectContaining({
          id: "active-compaction",
          title: "Compacting context",
          detail: "threshold",
        }),
      }),
    );
    expect(injections()).toHaveLength(0);
    expect(requestSystems(bodies[4]!)).toEqual(requestSystems(bodies[0]!));
    await runtime.setPiSetting({ key: "autoCompact", value: false });

    await writeFile(join(directory, ".pi", "APPEND_SYSTEM.md"), "CHANGED_CANONICAL_INSTRUCTION");
    await runtime.reload!();
    events.length = 0;
    await runtime.prompt("After an instruction change", "prompt", []);
    expect(injections()).toHaveLength(1);
    expect(requestSystems(bodies[5]!)[0]!.content).toContain("CHANGED_CANONICAL_INSTRUCTION");
    expect(requestSystems(bodies[5]!)[0]!.content).not.toContain("REQUIRED_CANONICAL_INSTRUCTION");
    const settled = await runtime.snapshot();
    expect(settled.parts).toContainEqual(
      expect.objectContaining({
        kind: "context",
        title: "System message",
        text: expect.stringContaining("CHANGED_CANONICAL_INSTRUCTION"),
      }),
    );
  });

  it("continues Pi → Cake → Pi with the same shared file and session ID", async () => {
    const directory = await createTemporaryDirectory();
    const agent = join(directory, "shared-agent");
    vi.stubEnv("PI_CODING_AGENT_DIR", agent);
    vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
    vi.stubEnv("PI_PROVIDER", "");
    vi.stubEnv("PI_MODEL", "");
    const paths = resolveCakePaths({
      env: { CAKE_HOME: join(directory, "cake") },
      piAgentDirectory: piAgentDirectory(),
    });
    await mkdir(agent);
    await writeFile(
      join(agent, "settings.json"),
      JSON.stringify({ defaultProvider: "fixture-provider", defaultModel: "fixture-model" }),
    );
    await registerFixtureProvider(directory, (index, response) =>
      finishTextResponse(response, `Shared reply ${index}`),
    );
    const terminal = await createAgentSession({ cwd: directory, agentDir: paths.piAgent });
    nativeSessions.push(terminal.session);
    const fixtureModel = terminal.session.modelRuntime.getModel(
      "fixture-provider",
      "fixture-model",
    );
    if (!fixtureModel) throw new Error("Fixture provider did not load; never use an ambient model");
    await terminal.session.setModel(fixtureModel);
    await terminal.session.prompt("Started in terminal");
    const manager = terminal.session.sessionManager;
    const id = manager.getSessionId();
    const file = manager.getSessionFile()!;
    expect(file.startsWith(paths.piSessions)).toBe(true);
    terminal.session.dispose();
    const runtime = await createCakeSessionRuntime({
      cwd: directory,
      agentDir: paths.piAgent,
      sessionDir: paths.piSessions,
      trusted: true,
      sessionId: id,
      requestUi: async () => undefined,
      onEvent: () => {},
    });
    runtimes.push(runtime);
    expect(runtime.sessionId).toBe(id);
    expect(runtime.sessionFile).toBe(file);
    expect(JSON.stringify((await runtime.snapshot()).parts)).toContain("Started in terminal");
    await runtime.setModel("fixture-provider", "fixture-model");
    await runtime.prompt("Continued in Cake", "prompt", [], false, undefined, undefined, false);
    await runtime.dispose();
    const continued = await createAgentSession({
      cwd: directory,
      agentDir: paths.piAgent,
      sessionManager: SessionManager.open(file),
    });
    nativeSessions.push(continued.session);
    const continuedModel = continued.session.modelRuntime.getModel(
      "fixture-provider",
      "fixture-model",
    );
    if (!continuedModel)
      throw new Error("Fixture provider did not load; never use an ambient model");
    await continued.session.setModel(continuedModel);
    expect(continued.session.sessionManager.getSessionId()).toBe(id);
    expect(JSON.stringify(continued.session.messages)).toContain("Continued in Cake");
    await continued.session.prompt("Returned to terminal");
    expect(continued.session.messages.filter((message) => message.role === "user")).toHaveLength(3);
    expect(JSON.stringify(continued.session.messages)).toContain("Shared reply 3");
  });
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
    const events: CakeSessionRuntimeEvent[] = [];
    const runtime = await createFixtureRuntime(directory, events);

    const prompt = runtime.prompt("Inspect with a tool", "prompt", []);
    await finalResponseStarted.promise;
    // A server write is not a client receipt; wait for Pi's projected delta.
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "part-updated",
          part: expect.objectContaining({ kind: "text", text: "Finished.", status: "streaming" }),
        }),
      ),
    );

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
    const events: CakeSessionRuntimeEvent[] = [];
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
    const events: CakeSessionRuntimeEvent[] = [];
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
    const events: CakeSessionRuntimeEvent[] = [];
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
