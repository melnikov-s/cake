import { describe, expect, it, vi } from "vitest";
import { Option } from "effect";
import { createModels, createProvider, normalizeContext, type Model } from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import {
  ANTHROPIC_FAST_MODE_BETA,
  OPENAI_FAST_MODE_SERVICE_TIER,
  applyFastModePayload,
  observeFastModeResponse,
  decodeFastModeResponseEvent,
  servedFastModeSpeed,
  supportsFastMode,
} from "../../../src/services/pi/fast-mode";
import { durableModels } from "../../../src/services/pi-durable/durable-models";
import { createCakeSessionRuntimeConfigurationState } from "../../../src/services/pi/runtime/cake-session-runtime-configuration";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

describe.each(["openai", "openai-codex", "openai-1m"])("%s Fast mode", (provider) => {
  it.each([
    "gpt-5.4",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-6-astra",
    "gpt-6-luna",
    "gpt-6-sol",
    "gpt-6.1-sol",
  ])("exposes Fast for %s", (id) => {
    expect(supportsFastMode({ provider, id })).toBe(true);
  });

  it.each(["gpt-5.4-mini", "gpt-5.3-codex-spark", "gpt-6.2-sol"])(
    "does not infer Fast support for %s",
    (id) => {
      expect(supportsFastMode({ provider, id })).toBe(false);
    },
  );

  it.each(["gpt-6.1-sol", "gpt-6-astra"])(
    "requests Fast rather than Ultrafast for %s only when enabled",
    (id) => {
      const model = { provider, id };
      const payload = { model: id, stream: true, prompt_cache_key: "session" };
      expect(applyFastModePayload(payload, model, true)).toEqual({
        ...payload,
        service_tier: OPENAI_FAST_MODE_SERVICE_TIER,
      });
      expect(payload).not.toHaveProperty("service_tier");
      expect(applyFastModePayload(payload, model, false)).toBe(payload);
    },
  );

  it("leaves unsupported model requests unchanged", () => {
    const payload = { model: "gpt-5.4-mini", service_tier: "default" };
    expect(applyFastModePayload(payload, { provider, id: "gpt-5.4-mini" }, true)).toBe(payload);
  });
});

describe.each(["anthropic", "anthropic-1m", "anthropic-250k-prefer-using-this-one"])(
  "%s Fast mode",
  (provider) => {
    it.each(["claude-opus-4-8", "claude-opus-5", "claude-opus-5-5"])(
      "exposes Fast for %s",
      (id) => {
        expect(supportsFastMode({ provider, id })).toBe(true);
      },
    );

    it.each(["claude-opus-4-6", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"])(
      "does not offer Fast for %s",
      (id) => {
        expect(supportsFastMode({ provider, id })).toBe(false);
      },
    );

    it("requests speed fast with the beta appended to Pi's betas only when enabled", () => {
      const model = { provider, id: "claude-opus-5-5" };
      const payload = { model: model.id, stream: true, betas: ["fine-grained-tool-streaming"] };
      expect(applyFastModePayload(payload, model, true)).toEqual({
        ...payload,
        speed: "fast",
        betas: ["fine-grained-tool-streaming", ANTHROPIC_FAST_MODE_BETA],
      });
      expect(payload).not.toHaveProperty("speed");
      expect(applyFastModePayload(payload, model, false)).toBe(payload);
    });

    it("adds the beta when Pi sent none and never duplicates it", () => {
      const model = { provider, id: "claude-opus-5" };
      expect(applyFastModePayload({ model: model.id }, model, true)).toMatchObject({
        betas: [ANTHROPIC_FAST_MODE_BETA],
      });
      expect(
        applyFastModePayload({ model: model.id, betas: [ANTHROPIC_FAST_MODE_BETA] }, model, true)
          .betas,
      ).toEqual([ANTHROPIC_FAST_MODE_BETA]);
    });
  },
);

it.each([
  { provider: "openrouter", id: "gpt-6.1-sol" },
  { provider: "github-copilot", id: "gpt-6-luna" },
  { provider: "openai-flex", id: "gpt-5.5" },
  { provider: "anthropic-flex", id: "claude-opus-5-5" },
  { provider: "github-copilot", id: "claude-opus-5" },
  { provider: "amazon-bedrock", id: "claude-opus-5-5" },
])("does not expose or apply Fast mode for gateway or flex provider $provider", (model) => {
  const payload = { model: model.id, stream: true };
  expect(supportsFastMode(model)).toBe(false);
  expect(applyFastModePayload(payload, model, true)).toBe(payload);
});

it("does not expose or apply Fast mode without a model", () => {
  const payload = { model: "gpt-6.1-sol" };
  expect(supportsFastMode(undefined)).toBe(false);
  expect(applyFastModePayload(payload, undefined, true)).toBe(payload);
});

describe("served speed", () => {
  const opus = { provider: "anthropic", id: "claude-opus-5-5" };
  const luna = { provider: "openai-1m", id: "gpt-6-luna" };
  const messageStart = (usage: object) => ({
    type: "message_start",
    message: { id: "msg", usage: { input_tokens: 1, output_tokens: 1, ...usage } },
  });
  // Stream callbacks receive raw events; decode them at that boundary as production does.
  const served = (model: { provider: string; id: string }, data: unknown) =>
    Option.match(decodeFastModeResponseEvent(data), {
      onNone: () => undefined,
      onSome: (event) => servedFastModeSpeed(model, event),
    });
  const feed = (observe: ReturnType<typeof observeFastModeResponse>, data: unknown) =>
    Option.map(decodeFastModeResponseEvent(data), observe);
  const completed = (service_tier?: string) => ({
    type: "response.completed",
    response: { id: "resp", ...(service_tier ? { service_tier } : {}) },
  });

  it("reads Anthropic usage.speed from message_start", () => {
    expect(served(opus, messageStart({ speed: "fast" }))).toBe("fast");
    expect(served(opus, messageStart({ speed: "standard" }))).toBe("standard");
    // Vertex/Bedrock fallback strips speed entirely.
    expect(served(opus, messageStart({}))).toBe("standard");
    expect(served(opus, { type: "content_block_delta" })).toBeUndefined();
  });

  it("ignores events from the other vendor's protocol", () => {
    expect(served(luna, messageStart({}))).toBeUndefined();
    expect(served(opus, completed("default"))).toBeUndefined();
  });

  it("reads the OpenAI service tier from response.completed", () => {
    expect(served(luna, completed("priority"))).toBe("fast");
    expect(served(luna, completed("fast"))).toBe("fast");
    expect(served(luna, completed("default"))).toBe("standard");
    expect(served(luna, completed())).toBeUndefined();
    expect(served(luna, { type: "response.output_text.delta" })).toBeUndefined();
  });

  it("warns once when a Fast request falls back silently", () => {
    const warn = vi.fn();
    const observe = observeFastModeResponse(opus, warn);
    feed(observe, { type: "ping" });
    feed(observe, messageStart({}));
    feed(observe, messageStart({}));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("anthropic/claude-opus-5-5");
  });

  it("stays quiet when the provider served Fast", () => {
    const warn = vi.fn();
    const observe = observeFastModeResponse(luna, warn);
    feed(observe, completed("priority"));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("Anthropic Fast mode through Pi's Messages adapter", () => {
  const opus: Model<"anthropic-messages"> = {
    provider: "anthropic",
    api: "anthropic-messages",
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    baseUrl: "https://proxy.shopify.ai/apis/anthropic",
    reasoning: false,
    input: ["text"],
    contextWindow: 200_000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = createModels();
  runtime.setProvider(
    createProvider({
      id: opus.provider,
      auth: {
        apiKey: { name: "Fixture", resolve: async () => ({ auth: { apiKey: "AUTH_SECRET" } }) },
      },
      models: [opus],
      api: { stream, streamSimple },
    }),
  );
  const sse = (speed?: string) =>
    new Response(
      [
        {
          type: "message_start",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            model: opus.id,
            content: [],
            usage: { input_tokens: 1, output_tokens: 0, ...(speed ? { speed } : {}) },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]
        .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );

  const send = async (speed: string | undefined) => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      requests.push(new Request(input, init));
      return sse(speed);
    };
    await durableModels(runtime, () => true).completeSimple(
      opus,
      normalizeContext({ messages: [{ role: "user", content: "Hello", timestamp: 1 }] }),
      { fetch, maxRetries: 0 },
    );
    const request = requests[0]!;
    return { body: JSON.parse(await request.text()), beta: request.headers.get("anthropic-beta") };
  };

  it("sends speed fast and the fast-mode beta header", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { body, beta } = await send("fast");
    expect(body).toMatchObject({ model: "claude-opus-5-5", speed: "fast" });
    expect(body).not.toHaveProperty("betas");
    expect(beta?.split(",")).toContain(ANTHROPIC_FAST_MODE_BETA);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a warning when the proxy serves the request at standard speed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await send(undefined);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("served at standard speed"));
    warn.mockRestore();
  });
});

describe("session runtime Fast mode extension", () => {
  type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;
  const install = (enabled: boolean) => {
    const state = createCakeSessionRuntimeConfigurationState({
      get: () => enabled,
      set: async () => undefined,
    });
    const opus = { provider: "anthropic", id: "claude-opus-5-5" };
    state.attachModel(opus);
    const handlers = new Map<string, Handler>();
    const pi = { on: (name: string, handler: Handler) => handlers.set(name, handler) };
    void (state.fastModeExtension as ExtensionFactory)(pi as unknown as ExtensionAPI);
    return {
      request: (payload: object) =>
        handlers.get("before_provider_request")!({ payload }, { model: opus }),
      streamEvent: (data: unknown) => handlers.get("provider_stream_event")!({ data }, {}),
    };
  };

  it("adds Anthropic Fast fields and warns when the response falls back", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = install(true);
    expect(session.request({ model: "claude-opus-5-5" })).toMatchObject({
      speed: "fast",
      betas: [ANTHROPIC_FAST_MODE_BETA],
    });
    session.streamEvent({ type: "message_start", message: { usage: { output_tokens: 1 } } });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("neither modifies nor checks requests while Fast mode is off", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = install(false);
    const payload = { model: "claude-opus-5-5" };
    expect(session.request(payload)).toEqual(payload);
    session.streamEvent({ type: "message_start", message: { usage: { output_tokens: 1 } } });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
