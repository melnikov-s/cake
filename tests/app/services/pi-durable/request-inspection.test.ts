import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { createModels, createProvider, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createRequestInspectionHistory } from "../../../../src/services/pi-durable/request-inspection";
import { durableModels } from "../../../../src/services/pi-durable/durable-models";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-durable-ai";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../../../src/contracts/conversations/cross-session-message";

const model: Model<"openai-completions"> = {
  provider: "fixture",
  api: "openai-completions",
  id: "fixture",
  name: "Fixture",
  baseUrl: "https://provider.test/v1",
  reasoning: false,
  input: ["text", "image"],
  contextWindow: 200_000,
  maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const event = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({ id: "reply", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const response = () =>
  new Response(
    event({ role: "assistant", content: "done" }, null) + event({}, "stop") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
const runtime = createModels();
runtime.setProvider(
  createProvider({
    id: "fixture",
    auth: {
      apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "AUTH_SECRET" } }) },
    },
    models: [model],
    api: { stream, streamSimple },
  }),
);

it("shortens coordination envelopes in provider context without changing canonical originals", async () => {
  const sender = "00000000-0000-4000-8000-000112345678";
  const other = "00000000-0000-4000-8000-000212345678";
  const envelope = encodeCrossSessionMessage(`Session ${sender} stopped without replying.`, {
    version: 1,
    messageId: "00000000-0000-4000-8000-000000000001",
    threadId: "00000000-0000-4000-8000-000000000002",
    sequence: 1,
    expectsResponse: false,
    generatedNotice: true,
    sender: { sessionId: sender, title: "Review worker", kind: "project-session" },
  });
  const ids = vi.fn(async () => [sender, other]);
  const models = durableModels(runtime, () => false, undefined, {
    ids,
    resolve: async () => sender,
    project: async (value) => value,
  });
  const sent: string[] = [];
  await models.completeSimple(
    model,
    normalizeContext({ messages: [{ role: "user", content: envelope, timestamp: 1 }] }),
    {
      fetch: async (input, init) => {
        sent.push(await new Request(input, init).text());
        return response();
      },
    },
  );
  expect(sent[0]).toContain("s:112345678");
  expect(sent[0]).toContain("Review worker");
  expect(sent[0]).not.toContain(sender);
  expect(parseCrossSessionMessage(envelope)?.metadata.sender.sessionId).toBe(sender);
  expect(ids).toHaveBeenCalledOnce();
});

it("captures exactly the real provider's serialized body, with tools, tool results, images and ordered instructions; later turns cannot mutate it", async () => {
  const history = createRequestInspectionHistory();
  const sent: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    sent.push(await new Request(input, init).text());
    return response();
  });
  const models = durableModels(runtime, () => false, history);
  const context = normalizeContext({
    systemPrompt:
      "CURRENT_USER_INSTRUCTIONS\n<current-time>2026-04-01</current-time>\n<chat>0+2|bounded memory</chat>",
    tools: [
      {
        name: "cake",
        description: "application control",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Question" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tool-1", name: "cake", arguments: { command: "projects.list" } },
        ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: 2,
        stopReason: "toolUse",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "cake",
        content: [{ type: "text", text: "PROJECTS_RESULT" }],
        isError: false,
        timestamp: 3,
      },
    ],
  });
  const reply = await models.completeSimple(model, context, {
    apiKey: "AUTH_SECRET",
    headers: { "x-secret": "HEADER_SECRET" },
    fetch,
    temperature: 0.2,
    maxTokens: 123,
    maxRetries: 0,
  });
  expect(reply.stopReason, reply.errorMessage).toBe("stop");
  const exact = history.list().entries.find((entry) => entry.boundary === "http-body");
  expect(exact).toMatchObject({
    sessionId: CAKE_CHAT_SESSION_ID,
    state: "completed",
    attempt: 1,
    purpose: "coordinator",
    provider: model.provider,
    modelId: model.id,
  });
  const captured = history.get(exact!.id)!;
  expect(captured.raw).toBe(sent[0]);
  const body = JSON.parse(captured.raw!);
  expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
    "system",
    "user",
    "assistant",
    "tool",
  ]);
  expect(body.tools[0].function.name).toBe("cake");
  expect(captured.raw).toContain("CURRENT_USER_INSTRUCTIONS");
  expect(captured.raw).toContain("bounded memory");
  expect(captured.raw).toContain("PROJECTS_RESULT");
  expect(captured.raw).toContain("data:image/png;base64,aGVsbG8=");
  expect(JSON.stringify(captured)).not.toMatch(/AUTH_SECRET|HEADER_SECRET/);
  expect(body).toMatchObject({ temperature: 0.2, max_completion_tokens: 123 });
  await models.completeSimple(
    model,
    normalizeContext({
      systemPrompt: "NEW COMPACTED HEAD",
      messages: [{ role: "user", content: "Next turn", timestamp: 4 }],
    }),
    { apiKey: "AUTH_SECRET", fetch, maxRetries: 0 },
  );
  expect(history.get(exact!.id)).toEqual(captured);
  expect(history.list().entries.filter((entry) => entry.boundary === "http-body")).toHaveLength(2);
  expect(new Set(history.list().entries.map((entry) => entry.callId)).size).toBe(2);
  expect(
    history.list().entries.find((entry) => entry.boundary === "provider-payload")?.limitation,
  ).toContain("NOT an exact");
});

it("captures after the caller's payload hook and Cake Fast mode, not the earlier assembled object", async () => {
  const selected = { ...model, provider: "openai-codex", id: "gpt-5.4" };
  const collection = createModels();
  collection.setProvider(
    createProvider({
      id: selected.provider,
      auth: {
        apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "AUTH_SECRET" } }) },
      },
      models: [selected],
      api: { stream, streamSimple },
    }),
  );
  const history = createRequestInspectionHistory();
  let sent = "";
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent = await new Request(input, init).text();
    return response();
  };
  await durableModels(collection, () => true, history).completeSimple(
    selected,
    normalizeContext({ messages: [{ role: "user", content: "Fast request", timestamp: 1 }] }),
    {
      fetch,
      maxRetries: 0,
      onPayload: (payload) => ({
        ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(payload),
        extension_tag: "final hook",
      }),
    },
  );
  const entry = history.list().entries.find((entry) => entry.boundary === "http-body")!;
  expect(history.get(entry.id)?.raw).toBe(sent);
  expect(JSON.parse(sent)).toMatchObject({ service_tier: "priority", extension_tag: "final hook" });
  expect(JSON.parse(entry.settings).fastMode).toBe(true);
});

it("captures every real Durable tool-loop call after bounded-head reset and remains immutable through actual compaction", async () => {
  const history = createRequestInspectionHistory();
  const sent: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    sent.push(await new Request(input, init).text());
    return sent.length === 1
      ? new Response(
          event(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "cake", arguments: '{"command":"projects.list"}' },
                },
              ],
            },
            "tool_calls",
          ) + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      : response();
  });
  vi.stubGlobal("fetch", fetch);
  const registry = createRegistry();
  const tool = defineTool({
    name: "cake",
    description: "Inspect application",
    parameters: Type.Object({ command: Type.String() }),
    replay: "safe",
    async execute() {
      return { content: [{ type: "text", text: "EXACT_TOOL_RESULT" }] };
    },
  });
  registry.install(defineExtension({ name: "cake", tools: [tool] }));
  const engine = await openDurableChatEngine({
    storage: new MemoryStorage(),
    models: durableModels(runtime, () => false, history),
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      instructions: "CURRENT_INSTRUCTIONS",
      tools: [tool],
    },
    memory: { budget: () => 4000, summarize: async () => "bounded summary" },
    settings: { contextRetentionMs: 0, compaction: { enabled: false, keepRecentTokens: 1 } },
    onChanged: () => {},
    onReport: () => {},
  });
  try {
    const input = await engine.root.submit(
      { type: "input", content: "First turn", requestId: "first" },
      BACKGROUND_CONTEXT,
    );
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    const requests = history.list().entries.filter((entry) => entry.boundary === "http-body");
    expect(requests).toHaveLength(2);
    const first = history.get(requests[0]!.id)!;
    expect(first.raw).toBe(sent[0]);
    expect(first.raw).toContain("<chat>");
    expect(first.raw).toContain("<current-time>");
    expect(first.raw).toContain("CURRENT_INSTRUCTIONS");
    expect(JSON.parse(first.raw!).tools[0].function.name).toBe("cake");
    expect(history.get(requests[1]!.id)!.raw).toBe(sent[1]);
    expect(sent[1]).toContain("EXACT_TOOL_RESULT");
    expect(requests[0]!.callId).not.toBe(requests[1]!.callId);
    const compact = await engine.root.compact(undefined, BACKGROUND_CONTEXT);
    await engine.harness.waitForTask(compact, BACKGROUND_CONTEXT);
    const next = await engine.root.submit(
      { type: "input", content: "Next independent turn", requestId: "next" },
      BACKGROUND_CONTEXT,
    );
    await next.wait(BACKGROUND_CONTEXT);
    expect(history.get(requests[0]!.id)).toEqual(first);
    expect(history.list().entries.filter((entry) => entry.boundary === "http-body")).toHaveLength(
      sent.length,
    );
  } finally {
    await engine.close();
    vi.unstubAllGlobals();
  }
});

it("records every fetch retry independently, keeps immutable bodies and failure states, and does not retain transport credentials/errors", async () => {
  const history = createRequestInspectionHistory();
  const capture = history.begin(CAKE_CHAT_SESSION_ID, model);
  const delegate = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response("SECRET_ERROR", { status: 429 }))
    .mockRejectedValueOnce(new Error("https://user:SECRET@provider.test?key=SECRET"))
    .mockResolvedValueOnce(new Response("okay"));
  const fetch = capture.fetch(delegate);
  const body = '{"messages":[{"role":"developer","content":"exact"}],"tools":[{"name":"cake"}]}\n';
  const init = { method: "POST", body, headers: { Authorization: "SECRET" } };
  await fetch("https://user:SECRET@provider.test?key=SECRET", init);
  await expect(fetch("https://provider.test", init)).rejects.toThrow("SECRET");
  await fetch("https://provider.test", init);
  capture.settle(false);
  expect(history.list().entries.map((entry) => [entry.attempt, entry.state, entry.status])).toEqual(
    [
      [1, "failed", 429],
      [2, "failed", undefined],
      [3, "completed", 200],
    ],
  );
  for (const entry of history.list().entries) expect(history.get(entry.id)?.raw).toBe(body);
  expect(JSON.stringify(history.list())).not.toContain("SECRET");
  const snapshot = history.list();
  Object.assign(snapshot.entries[0]!, { id: "mutated-client" });
  expect(history.list().entries[0]?.id).not.toBe("mutated-client");
});

it("captures both attempts of Pi's actual provider retry without rerunning payload assembly", async () => {
  vi.useFakeTimers();
  const history = createRequestInspectionHistory();
  const sent: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    sent.push(await new Request(input, init).text());
    return sent.length === 1
      ? new Response("temporarily unavailable", { status: 429, headers: { "retry-after-ms": "1" } })
      : response();
  });
  try {
    const call = durableModels(runtime, () => false, history).completeSimple(
      model,
      normalizeContext({ messages: [{ role: "user", content: "retry this call", timestamp: 1 }] }),
      { fetch, maxRetries: 1, maxRetryDelayMs: 100 },
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((await call).stopReason).toBe("stop");
    const entries = history.list().entries;
    const attempts = entries.filter((entry) => entry.boundary === "http-body");
    expect(attempts.map((entry) => [entry.attempt, entry.state])).toEqual([
      [1, "failed"],
      [2, "completed"],
    ]);
    expect(attempts[0]!.callId).toBe(attempts[1]!.callId);
    expect(entries.filter((entry) => entry.boundary === "provider-payload")).toHaveLength(1);
    expect(history.get(attempts[0]!.id)?.raw).toBe(sent[0]);
    expect(history.get(attempts[1]!.id)?.raw).toBe(sent[1]);
    expect(sent[0]).toBe(sent[1]);
  } finally {
    vi.useRealTimers();
  }
});

it("does not inject a custom fetch into Pi's Google adapters, which explicitly reject overrides", () => {
  const history = createRequestInspectionHistory();
  for (const api of ["google-generative-ai", "google-vertex"]) {
    const capture = history.begin(CAKE_CHAT_SESSION_ID, { ...model, api });
    expect(capture.fetch()).toBe(globalThis.fetch);
    capture.payload({ contents: [{ parts: [{ text: "real Google payload" }] }] });
    capture.settle(false);
  }
  expect(history.list().entries.every((entry) => entry.boundary === "provider-payload")).toBe(true);
});

it("bounds whole-body retention, reports oversized bodies explicitly, and Clear invalidates in-flight capture callbacks", async () => {
  const history = createRequestInspectionHistory(2, 64);
  const capture = history.begin(CAKE_CHAT_SESSION_ID, model);
  const fetch = capture.fetch(async () => new Response("ok"));
  for (const body of ["first", "second", "third"])
    await fetch("https://provider.test", { method: "POST", body });
  expect(history.list().entries).toHaveLength(2);
  expect(history.list().evicted).toBe(1);
  await fetch("https://provider.test", { method: "POST", body: "x".repeat(65) });
  const oversized = history.get(history.list().entries.at(-1)!.id)!;
  expect(oversized.raw).toBeUndefined();
  expect(oversized.entry.limitation).toContain("was not retained");
  history.clear();
  capture.payload({ messages: ["after-clear"] });
  await fetch("https://provider.test", { method: "POST", body: "after-clear" });
  capture.settle(false);
  expect(history.list()).toMatchObject({ entries: [], evicted: 0 });
});

it("labels non-fetch payloads and unavailable hooks honestly, including memory-summary identities and binary data", () => {
  const history = createRequestInspectionHistory();
  const capture = history.begin(CAKE_CHAT_SESSION_ID, model, undefined, false, "memory-summary");
  capture.payload({ source: { bytes: new Uint8Array([0, 1, 2]) } });
  capture.settle(false);
  const entry = history.list().entries[0]!;
  expect(entry.purpose).toBe("memory-summary");
  expect(entry.boundary).toBe("provider-payload");
  expect(entry.limitation).toContain("WebSocket/Bedrock");
  expect(JSON.parse(history.get(entry.id)!.raw!)).toEqual({
    source: { bytes: { encoding: "base64", data: "AAEC" } },
  });
  history.begin(CAKE_CHAT_SESSION_ID, model).settle(true);
  expect(history.list().entries.at(-1)?.limitation).toContain("did not invoke");
});
