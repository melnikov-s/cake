import {
  createAssistantMessageEventStream,
  createModels,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-durable-ai";
import { vi } from "vitest";

export const durableModel: Model<"openai-completions"> = {
  id: "fixture",
  provider: "fixture",
  name: "Durable fixture",
  api: "openai-completions",
  baseUrl: "http://unused.invalid",
  reasoning: false,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4_096,
};
export function durableAnswer(
  text: string,
  content?: AssistantMessage["content"],
): AssistantMessage {
  return {
    role: "assistant",
    content: content ?? [{ type: "text", text }],
    api: durableModel.api,
    provider: durableModel.provider,
    model: durableModel.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content?.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}
export function durableModels(
  answer: (request: Context, index: number) => AssistantMessage = () => durableAnswer("Done"),
) {
  const models = createModels();
  const requests: Context[] = [];
  vi.spyOn(models, "getModel").mockReturnValue(durableModel);
  vi.spyOn(models, "streamSimple").mockImplementation((_model, request) => {
    requests.push(structuredClone(request));
    const stream = createAssistantMessageEventStream();
    const message = answer(request, requests.length);
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (message.stopReason === "error" || message.stopReason === "aborted")
        stream.push({ type: "error", reason: message.stopReason, error: message });
      else if (message.stopReason !== "pending")
        stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  });
  return { models, requests };
}
