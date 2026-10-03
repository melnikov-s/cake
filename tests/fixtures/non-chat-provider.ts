/** Deterministic native provider fixture. Never sends a network request. */
export function nonChatProviderSource(tracePath: string): string {
  return `
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
export default (pi) => {
  const base = { provider: "non-chat-fixture", baseUrl: "http://127.0.0.1:9", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, input: ["text"] };
  const chat = { ...base, id: "chat", name: "Fixture chat", api: "fixture-chat", reasoning: false, contextWindow: 64000, maxTokens: 1000 };
  const images = ["image-a", "image-b"].map(id => ({ ...base, id, name: id, api: "fixture-images", type: "image", output: ["image"] }));
  const classifiers = ["classifier-a", "classifier-b"].map(id => ({ ...base, id, name: id, api: "fixture-classifier", type: "classifier", contextWindow: 1000 }));
  function stream(model, context) {
    const output = createAssistantMessageEventStream();
    const last = context.messages.findLast(message => message.role === "user" || message.role === "toolResult");
    const prompt = last?.role === "user" ? last.content.filter(p => p.type === "text").map(p => p.text).join("\\n") : "";
    const code = prompt.startsWith("SCRIPT:") ? prompt.slice(7) : undefined;
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: code ? [{ type: "toolCall", id: "native-script", name: "codemode", arguments: { code } }] : [{ type: "text", text: last?.role === "toolResult" ? "Native result: " + JSON.stringify(last.content) : "Fixture ready" }],
      stopReason: code ? "toolUse" : "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    output.push({ type: "start", partial: message });
    output.push({ type: "done", reason: message.stopReason, message }); output.end(); return output;
  }
  pi.registerProvider({
    id: "non-chat-fixture", name: "Non-chat fixture",
    auth: { apiKey: { name: "Fixture key", resolve: async () => ({ auth: { apiKey: "fixture" }, source: "fixture credential" }) } },
    getModels: () => [chat], getAllModels: () => [chat, ...images, ...classifiers], stream, streamSimple: stream,
    async generateImages(model, context, options) {
      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ type: "image", model: model.id, context }) + "\\n");
      if (context.input.some(p => p.type === "text" && p.text === "wait")) {
        await new Promise(resolve => { if (options.signal.aborted) resolve(); else options.signal.addEventListener("abort", resolve, { once: true }); });
        appendFileSync(${JSON.stringify(tracePath)}, "cancelled\\n");
        return { provider: model.provider, model: model.id, output: [], stopReason: "aborted" };
      }
      return { provider: model.provider, model: model.id, output: [{ type: "text", text: model.id }], stopReason: "stop" };
    },
    async classify(model, context) {
      appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ type: "classifier", model: model.id, context }) + "\\n");
      return { provider: model.provider, model: model.id, answers: { approved: { type: "bool", probability: 0.8 } }, stopReason: "stop" };
    }
  });
};`;
}

export function nativeNonChatScript(type: "image" | "classifier", requestedId?: string): string {
  const input = {
    type,
    ...(requestedId ? { requested: { provider: "non-chat-fixture", modelId: requestedId } } : {}),
  };
  const context =
    type === "image"
      ? { input: [{ type: "text", text: "fixture" }] }
      : {
          state: { message: "Approved" },
          questions: {
            approved: {
              type: "bool",
              instructions: "Approved?",
              criteria: { true: "Yes", false: "No" },
            },
          },
        };
  return `const {result: selected} = await tools.cake({command: "models.select-non-chat", input: ${JSON.stringify(input)}}); if (!selected.model) return selected; const result = await models.${type === "image" ? "generateImages" : "classify"}(selected.model, ${JSON.stringify(context)}); return {selected, stopReason: result.stopReason, model: result.model};`;
}
