import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  cakeChatCacheFreshness,
  CakeChatCacheRequest,
} from "../../../../src/contracts/cake-chats/context-policy";
import { durableModels } from "../../../../src/services/pi-durable/durable-models";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import {
  anthropicCacheEstimate,
  durableCacheEvidence,
} from "../../../../src/services/pi-durable/durable-cache-evidence";
import { durableModel } from "../../../fixtures/durable-chat";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const at = 1_000_000;
const base: CakeChatCacheRequest = {
  provider: "anthropic",
  modelId: "fixture",
  requestedAt: at,
  inputTokens: 100,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cake-cache-evidence-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
  });
  const provider = runtime.getProvider("anthropic");
  if (!provider) throw new Error("Missing Anthropic provider");
  const model = {
    ...durableModel,
    api: "anthropic-messages" as const,
    provider: "anthropic",
    baseUrl: "https://anthropic.invalid",
    compat: { supportsLongCacheRetention: true },
  };
  let envRetention = "long";
  let requested: "none" | "short" | "long" | undefined;
  let clock = at;
  let creation = { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 };
  let read = 0;
  const payloads: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    payloads.push(JSON.parse(await new Request(input, init).text()));
    const usage = {
      input_tokens: 100,
      output_tokens: 1,
      cache_read_input_tokens: read,
      cache_creation_input_tokens:
        creation.ephemeral_5m_input_tokens + creation.ephemeral_1h_input_tokens,
      cache_creation: creation,
    };
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: model.id,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage,
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage },
      { type: "message_stop" },
    ];
    return new Response(
      events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  runtime.registerNativeProvider({
    ...provider,
    getModels: () => [model],
    getAllModels: () => [model],
    streamSimple: (selected, context, options) =>
      streamSimple({ ...selected, api: "anthropic-messages", compat: model.compat }, context, {
        ...options,
        env: { ...options?.env, PI_CACHE_RETENTION: envRetention },
        fetch,
      }),
  });
  await runtime.setRuntimeApiKey("anthropic", "fixture-key");
  const summarize = vi.fn(async () => "talk: preserved history via zoom");
  const open = async () => {
    const engine = await openDurableChatEngine({
      storage: await openNodeSqliteStorage(join(directory, "chat.sqlite")),
      models: durableModels(runtime),
      registry: createRegistry(),
      agent: { model: { provider: model.provider, modelId: model.id }, instructions: "Fixture" },
      memory: { budget: () => 2000, summarize },
      now: () => clock,
      settings: {
        contextRetentionMs: 0,
        compaction: { enabled: false },
        get stream() {
          return requested ? { cacheRetention: requested } : {};
        },
      },
      onChanged: () => undefined,
      onReport: vi.fn(),
    });
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await engine.close();
      }
    };
    cleanup.push(close);
    return {
      engine,
      close,
      send: async (content: string, requestId: string) =>
        (await engine.root.submit({ type: "input", content, requestId }, BACKGROUND_CONTEXT)).wait(
          BACKGROUND_CONTEXT,
        ),
      status: () => engine.contextStatus(model),
    };
  };
  return {
    open,
    summarize,
    payloads,
    model,
    advance: (ms: number) => {
      clock += ms;
    },
    usage: (short: number, long: number, reads = 0) => {
      creation = { ephemeral_5m_input_tokens: short, ephemeral_1h_input_tokens: long };
      read = reads;
    },
    request: (value: typeof requested) => {
      requested = value;
    },
    env: (value: string) => {
      envRetention = value;
    },
  };
}

it("roundtrips installed Anthropic TTL usage through ModelRuntime, Durable and SQLite; rolling one-hour reads survive restart and a five-minute default", async () => {
  const f = await fixture();
  const first = await f.open();
  expect((await first.send("ORIGINAL_ONE_HOUR ".repeat(100), "first")).status).toBe("done");
  const cache = (await first.status()).cache!;
  expect(cache).toMatchObject({
    api: "anthropic-messages",
    cacheWriteTokens: 2000,
    cacheWrite1hTokens: 2000,
    cacheWrite5mTokens: 0,
    requestedAt: at,
    completedAt: at,
    resolvedRetention: {
      source: "provider-payload",
      enabled: true,
      anthropic1h: true,
      anthropic5m: false,
    },
    anthropicEstimate: { oneHourAt: at },
  });
  expect(cache.retention).toBeUndefined();
  const active = await first.engine.root.context(BACKGROUND_CONTEXT);
  expect(active.messages.find((m) => m.role === "assistant")?.usage.cacheWrite1h).toBe(2000);
  await first.close();
  f.advance(10 * 60_000);
  f.env("short");
  f.usage(0, 0, 2000);
  const second = await f.open();
  expect((await second.status()).cache).toEqual(cache);
  expect((await second.send("Still warm after restart", "second")).status).toBe("done");
  expect(f.summarize).not.toHaveBeenCalled();
  expect(JSON.stringify(f.payloads[1])).toContain("ORIGINAL_ONE_HOUR");
  const read = (await second.status()).cache!;
  expect(read).toMatchObject({
    cacheReadTokens: 2000,
    cacheWrite1hTokens: 0,
    resolvedRetention: { anthropic1h: false, anthropic5m: true },
    anthropicEstimate: { oneHourAt: at + 10 * 60_000 },
  });
  expect(cakeChatCacheFreshness(read, at + 65 * 60_000).state).toBe("likely-warm");
  expect(cakeChatCacheFreshness(read, at + 70 * 60_000).state).toBe("likely-cold");
});

it("keeps requested policy distinct from resolved defaults and compatibility, and uses reported five-minute writes", async () => {
  const f = await fixture();
  f.request("long");
  f.model.compat.supportsLongCacheRetention = false;
  f.usage(2000, 0);
  const chat = await f.open();
  await chat.send("FIVE_MINUTE_ORIGINAL ".repeat(100), "first");
  const cache = (await chat.status()).cache!;
  expect(cache).toMatchObject({
    retention: "long",
    resolvedRetention: { anthropic1h: false, anthropic5m: true },
    cacheWrite5mTokens: 2000,
    cacheWrite1hTokens: 0,
  });
  expect(cakeChatCacheFreshness(cache, at + 5 * 60_000).state).toBe("likely-cold");
  f.advance(6 * 60_000);
  await chat.send("Cold now", "second");
  expect(f.summarize).toHaveBeenCalled();
});

it("roundtrips mixed Anthropic TTL counters and does not rewrite on the next warm independent turn", async () => {
  const f = await fixture();
  f.usage(1000, 2000);
  const chat = await f.open();
  await chat.send("MIXED_ORIGINAL", "first");
  expect((await chat.status()).cache).toMatchObject({
    cacheWriteTokens: 3000,
    cacheWrite1hTokens: 2000,
    cacheWrite5mTokens: 1000,
    anthropicEstimate: { fiveMinuteAt: at, oneHourAt: at },
  });
  f.advance(60_000);
  f.usage(0, 0, 500);
  await chat.send("Mixed prefix read", "second");
  expect(f.summarize).not.toHaveBeenCalled();
  expect((await chat.status()).cache?.anthropicEstimate).toMatchObject({
    fiveMinuteAt: at,
    oneHourAt: at,
  });
});

it("captures the installed five-minute default and retains conservative unknown resets with no reported cached input", async () => {
  const f = await fixture();
  f.env("");
  f.usage(0, 0);
  const chat = await f.open();
  await chat.send("UNKNOWN_ORIGINAL ".repeat(100), "first");
  const cache = (await chat.status()).cache!;
  expect(cache.retention).toBeUndefined();
  expect(cache.resolvedRetention).toMatchObject({ anthropic5m: true, anthropic1h: false });
  expect(cakeChatCacheFreshness(cache, at).state).toBe("unknown");
  await chat.send("Conservative independent input", "second");
  expect((await chat.status()).lastSummary?.reason).toBe("cache-unknown");
  expect(f.summarize).toHaveBeenCalled();
});

it("captures structured Bedrock TTLs and explicit OpenAI options without transferring Anthropic semantics", () => {
  const bedrock = durableCacheEvidence("bedrock-converse-stream");
  bedrock.payload({
    system: [{ cachePoint: { type: "default", ttl: "1h" } }],
    messages: [{ content: [{ cachePoint: { type: "default" } }] }],
  });
  bedrock.event({
    metadata: {
      usage: {
        cacheDetails: [
          { ttl: "1h", inputTokens: 2000 },
          { ttl: "5m", inputTokens: 1000 },
        ],
      },
    },
  });
  expect(bedrock.snapshot()).toEqual({
    resolvedRetention: {
      source: "provider-payload",
      enabled: true,
      bedrock1h: true,
      bedrock5m: true,
    },
    cacheWrite5mTokens: 1000,
    cacheWrite1hTokens: 2000,
  });
  const nova = durableCacheEvidence("bedrock-converse-stream");
  nova.payload({ messages: [] });
  expect(nova.snapshot()).toEqual({});
  const openai = durableCacheEvidence("openai-responses");
  openai.payload({ prompt_cache_options: { ttl: "30m" }, prompt_cache_retention: "24h" });
  expect(openai.snapshot().resolvedRetention).toMatchObject({
    enabled: true,
    openaiTtl: "30m",
    openaiRetention: "24h",
  });
  openai.payload({ prompt_cache_options: { mode: "explicit" } });
  expect(openai.snapshot().resolvedRetention).toMatchObject({
    enabled: false,
    openaiMode: "explicit",
  });
});

it("keeps mixed TTL creation separate and does not attribute an ambiguous read to the one-hour prefix", () => {
  const mixed = {
    ...base,
    cacheWriteTokens: 3000,
    cacheWrite1hTokens: 2000,
    cacheWrite5mTokens: 1000,
  };
  const previous = { ...mixed, anthropicEstimate: anthropicCacheEstimate(mixed, undefined) };
  const read = { ...base, requestedAt: at + 60_000, cacheReadTokens: 500 };
  const estimate = anthropicCacheEstimate(read, previous);
  expect(estimate).toMatchObject({ fiveMinuteAt: at, oneHourAt: at });
  expect(
    cakeChatCacheFreshness({ ...read, anthropicEstimate: estimate }, at + 10 * 60_000).state,
  ).toBe("likely-warm");
  expect(
    cakeChatCacheFreshness({ ...read, anthropicEstimate: estimate }, at + 60 * 60_000).state,
  ).toBe("likely-cold");
});

it("decodes legacy records without manufacturing resolved policy or expiry fields, preserving one-hour usage when available", () => {
  const legacy = Schema.decodeUnknownSync(CakeChatCacheRequest)(base);
  expect(legacy.resolvedRetention).toBeUndefined();
  expect(legacy.anthropicEstimate).toBeUndefined();
  expect(cakeChatCacheFreshness(legacy, at).state).toBe("unknown");
  expect(
    cakeChatCacheFreshness(
      { ...legacy, cacheWriteTokens: 2000, cacheWrite1hTokens: 2000 },
      at + 10 * 60_000,
    ).state,
  ).toBe("likely-warm");
  const absent = durableCacheEvidence("other");
  absent.payload({});
  absent.event({});
  expect(absent.snapshot()).toEqual({});
  const openai = durableCacheEvidence("openai-responses");
  openai.payload({ prompt_cache_retention: "24h" });
  expect(openai.snapshot().resolvedRetention).toEqual({
    source: "provider-payload",
    enabled: true,
    openaiRetention: "24h",
  });
  const anthropic = durableCacheEvidence("anthropic-messages");
  anthropic.payload({
    tools: [{ input_schema: { cache_control: { type: "ephemeral", ttl: "1h" } } }],
    messages: [
      {
        content: [{ type: "tool_use", input: { cache_control: { type: "ephemeral", ttl: "1h" } } }],
      },
    ],
  });
  expect(anthropic.snapshot().resolvedRetention?.enabled).toBe(false);
});
