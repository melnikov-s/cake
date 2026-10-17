import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import {
  runInlineWidgetGeneration,
  runInlineWidgetVisualReview,
} from "../../src/services/pi/runtime/sidecar-runtime";
import { captureWidgetConversation } from "../../src/services/pi/runtime/widget-conversation";

const directories: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("artifact branches through the real Pi runtime", () => {
  it("preserves ancestor context, loads bundled skills with scoped candidate tools, and applies the parent cache key", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cake-widget-runtime-"));
    directories.push(cwd);
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir);
    const parentDir = join(cwd, "sessions");
    const sessionDir = join(cwd, "widgets");
    const requests: Array<{
      messages: Message[];
      payload: unknown;
      sessionId: string | undefined;
    }> = [];
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"),
      refreshOnCreate: false,
    });
    runtime.registerProvider("widget-fixture", {
      api: "openai-responses",
      baseUrl: "https://widget-fixture.invalid",
      apiKey: "fixture",
      models: [
        {
          id: "vision",
          name: "Fixture vision",
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 1024,
        },
      ],
      streamSimple(model, context, options) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const payload = await options?.onPayload?.(
            { prompt_cache_key: options.sessionId },
            model,
          );
          requests.push({
            messages: structuredClone(context.messages),
            payload,
            sessionId: options?.sessionId,
          });
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "pending",
            timestamp: 1,
          };
          stream.push({ type: "start", partial: message });
          const text =
            requests.length === 1
              ? "```cake-react\nexport default function Chart(){return <div>Verified facts</div>}\n```"
              : "ACCEPT_CURRENT";
          message.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          message.content[0] = { type: "text", text };
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          message.stopReason = "stop";
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        })().catch((error: unknown) => {
          const message: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage,
            stopReason: "error",
            errorMessage: String(error),
            timestamp: 1,
          };
          stream.push({ type: "error", reason: "error", error: message });
          stream.end();
        });
        return stream;
      },
    });
    vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
    const parent = SessionManager.create(cwd, parentDir);
    parent.appendModelChange("widget-fixture", "vision");
    parent.appendMessage({
      role: "system",
      content: "",
      sections: {
        preamble: "Preserve the original requirements.",
        project_context: "<project_context>\nOnly verified revenue data.\n</project_context>",
        tools: "<tools>\nwrite files\n</tools>",
      },
      toolsAdded: [
        {
          name: "write",
          description: "Write a file",
          parameters: { type: "object", properties: {} },
        },
      ],
      timestamp: 1,
    });
    parent.appendMessage({
      role: "user",
      content: "Use quarterly labels from our discussion.",
      timestamp: 1,
    });
    const inherited = parent.buildSessionContext().messages;
    const origin = captureWidgetConversation({ sessionManager: parent });
    const sourceFile = parent.getSessionFile()!;
    const sourceLeaf = parent.getLeafId();
    const options = {
      cwd,
      agentDir,
      sessionDir,
      sessionRoots: [parentDir, sessionDir],
      model: { provider: "widget-fixture", id: "vision" },
    };
    const generated = await runInlineWidgetGeneration({
      ...options,
      conversation: { type: "parent", origin },
      brief: "Make the chart",
      fallback: "Quarterly revenue",
      candidate: { source: "", state: null },
    });
    expect(generated.response).toContain("Verified facts");
    expect(requests[0]!.messages.slice(0, inherited.length)).toEqual(inherited);
    expect(getCurrentSystemPrompt(requests[0]!.messages)).toContain(
      "Preserve the original requirements.",
    );
    expect(getCurrentSystemPrompt(requests[0]!.messages)).toContain("Only verified revenue data.");
    expect(getCurrentSystemPrompt(requests[0]!.messages)).toContain(
      "self-contained interactive Cake widget",
    );
    expect(getCurrentTools(requests[0]!.messages).map((tool) => tool.name)).toEqual([
      "widget_read",
      "widget_edit",
      "read",
    ]);
    expect(getCurrentSystemPrompt(requests[0]!.messages)).toContain("cake:prototype-ui");
    expect(requests[0]!.payload).toMatchObject({ prompt_cache_key: parent.getSessionId() });
    expect(requests[0]!.sessionId).toBe(generated.sessionId);
    expect(generated.sessionId).not.toBe(parent.getSessionId());
    expect(SessionManager.open(sourceFile).getLeafId()).toBe(sourceLeaf);

    const reviewed = await runInlineWidgetVisualReview({
      ...options,
      conversation: { type: "continue", sessionId: generated.sessionId },
      source: generated.response,
      context: "Quarterly revenue",
      diagnostic: "Readable",
      pngBase64: "cG5n",
    });
    expect(reviewed.sessionId).toBe(generated.sessionId);
    expect(reviewed.response).toBe("ACCEPT_CURRENT");
    expect(requests[1]!.messages.slice(0, inherited.length)).toEqual(inherited);
    expect(getCurrentTools(requests[1]!.messages)).toEqual([]);
    expect(requests[1]!.payload).toMatchObject({ prompt_cache_key: parent.getSessionId() });
  });
});
