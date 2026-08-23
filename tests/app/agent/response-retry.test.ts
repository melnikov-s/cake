import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ResponseRetryController } from "../../../src/agent/response-retry";

type StreamFunction = AgentSession["agent"]["streamFunction"];

const usage: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  stopReason: AssistantMessage["stopReason"],
  errorMessage?: string,
  content: AssistantMessage["content"] = [],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage,
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}

function response(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: message });
    stream.push(
      message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : {
            type: "done",
            reason: message.stopReason as "stop" | "length" | "toolUse" | "deferred",
            message,
          },
    );
  });
  return stream;
}

const model = {} as Model<"openai-completions">;
const context: Context = { messages: [] };

async function streamResult(stream: ReturnType<StreamFunction>) {
  return (await stream).result();
}

describe("ResponseRetryController", () => {
  it("retries empty 429 responses with the configured schedule", async () => {
    const notices = vi.fn();
    const finished = vi.fn();
    const responses = [
      assistant("error", "429 Too Many Requests"),
      assistant("error", "temporarily rate-limited"),
      assistant("stop", undefined, [{ type: "text", text: "Recovered" }]),
    ];
    const base = vi.fn<StreamFunction>(() => response(responses.shift()!));
    const controller = new ResponseRetryController({
      enabled: () => true,
      onRetry: notices,
      onFinished: finished,
      delaysMs: [1, 3, 200],
      maxElapsedMs: 100,
    });

    const result = await streamResult(controller.wrap(base)(model, context));

    expect(result.content).toEqual([{ type: "text", text: "Recovered" }]);
    expect(base).toHaveBeenCalledTimes(3);
    expect(notices.mock.calls.map(([notice]) => notice)).toEqual([
      expect.objectContaining({ attempt: 1, maxAttempts: 2, delayMs: 1 }),
      expect.objectContaining({ attempt: 2, maxAttempts: 2, delayMs: 3 }),
    ]);
    expect(finished).toHaveBeenCalledOnce();
  });

  it("retries a well-formed empty response with the same request", async () => {
    const notices = vi.fn();
    const responses = [
      assistant("stop"),
      assistant("stop", undefined, [{ type: "text", text: "Recovered" }]),
    ];
    const base = vi.fn<StreamFunction>(() => response(responses.shift()!));
    const controller = new ResponseRetryController({
      enabled: () => true,
      onRetry: notices,
      onFinished: vi.fn(),
      delaysMs: [1],
      maxElapsedMs: 10,
    });

    const result = await streamResult(controller.wrap(base)(model, context));

    expect(result.content).toEqual([{ type: "text", text: "Recovered" }]);
    expect(base).toHaveBeenCalledTimes(2);
    expect(base.mock.calls[1]?.[1]).toBe(context);
    expect(notices).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        delayMs: 1,
        errorMessage: "The provider returned an empty response.",
      }),
    );
  });

  it("returns a non-retryable error after exhausting the schedule", async () => {
    const base = vi.fn<StreamFunction>(() => response(assistant("error", "429 Too Many Requests")));
    const controller = new ResponseRetryController({
      enabled: () => true,
      onRetry: vi.fn(),
      onFinished: vi.fn(),
      delaysMs: [1, 100],
      maxElapsedMs: 50,
    });

    const result = await streamResult(controller.wrap(base)(model, context));

    expect(base).toHaveBeenCalledTimes(2);
    expect(result.errorMessage).toBe(
      "Automatic provider-throttling retries stopped after the retry window (1 retry).",
    );
  });

  it("returns an error after exhausting empty-response retries", async () => {
    const base = vi.fn<StreamFunction>(() => response(assistant("stop")));
    const controller = new ResponseRetryController({
      enabled: () => true,
      onRetry: vi.fn(),
      onFinished: vi.fn(),
      delaysMs: [1, 100],
      maxElapsedMs: 50,
    });

    const result = await streamResult(controller.wrap(base)(model, context));

    expect(base).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Automatic empty-response retries stopped after the retry window (1 retry).",
    );
  });

  it("does not replay a request after meaningful output", async () => {
    const partial = assistant("pending", undefined, [{ type: "text", text: "Partial" }]);
    const failed = assistant("error", "429 Too Many Requests", [{ type: "text", text: "Partial" }]);
    const base = vi.fn<StreamFunction>(() => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        stream.push({ type: "error", reason: "error", error: failed });
      });
      return stream;
    });
    const controller = new ResponseRetryController({
      enabled: () => true,
      onRetry: vi.fn(),
      onFinished: vi.fn(),
      delaysMs: [1],
      maxElapsedMs: 1,
    });

    const result = await streamResult(controller.wrap(base)(model, context));

    expect(result.errorMessage).toContain("stopped to avoid replaying work");
    expect(base).toHaveBeenCalledOnce();
  });
});
