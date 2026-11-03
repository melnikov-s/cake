import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import { Schema } from "effect";
import {
  EMPTY_TOOL_ERROR_PLACEHOLDER,
  emptyToolErrorExtension,
  fillEmptyToolErrors,
  toolFailureMessage,
} from "../../../src/services/pi/runtime/tool-error-text";
import { createCakeToolDefinition } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { ArtifactPublicationConflict } from "../../../src/contracts/storage/artifact-storage-errors";

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function toolResult(content: Extract<Message, { role: "toolResult" }>["content"], isError = true) {
  return {
    role: "toolResult" as const,
    toolCallId: "call-1",
    toolName: "cake",
    content,
    isError,
    timestamp: 1,
  };
}

class EmptyTaggedError extends Schema.TaggedError<EmptyTaggedError>()("EmptyTaggedError", {
  lineageId: Schema.String,
}) {}

describe("tool error text", () => {
  it("fills failed tool results that have no text", () => {
    const messages = [
      toolResult([]),
      toolResult([{ type: "text", text: "  \n" }]),
      toolResult([{ type: "text", text: "Real failure" }]),
      toolResult([], false),
    ];

    expect(
      fillEmptyToolErrors(messages)?.map((message) =>
        "content" in message ? message.content : undefined,
      ),
    ).toEqual([
      [{ type: "text", text: EMPTY_TOOL_ERROR_PLACEHOLDER }],
      [{ type: "text", text: EMPTY_TOOL_ERROR_PLACEHOLDER }],
      [{ type: "text", text: "Real failure" }],
      [],
    ]);
    expect(fillEmptyToolErrors(messages.slice(2))).toBeUndefined();
  });

  it("describes a publication conflict for a reused artifact id", () => {
    const conflict = new ArtifactPublicationConflict({
      lineageId: "goal-header-settings-vs-actions",
      expectedLatestRevision: 0,
      actualLatestRevision: 1,
    });

    expect(conflict.message).toContain('"goal-header-settings-vs-actions" already exists');
    expect(toolFailureMessage(conflict)).toBe(conflict.message);
  });

  it("names a tagged error and its fields when it has no message", () => {
    expect(toolFailureMessage(new EmptyTaggedError({ lineageId: "a" }))).toBe(
      'EmptyTaggedError {"lineageId":"a"}',
    );
    expect(toolFailureMessage(new Error(""))).toBe("Error");
    expect(toolFailureMessage("")).toBe(EMPTY_TOOL_ERROR_PLACEHOLDER);
  });

  it("rejects a Cake tool call with text when the operation error has no message", async () => {
    const tool = createCakeToolDefinition([
      {
        command: "html.present",
        topic: "html",
        summary: "Present HTML.",
        inputSchema: Schema.Struct({}),
        examples: [{}],
        result: "Metadata.",
        execute: async () => {
          throw new EmptyTaggedError({ lineageId: "goal-header" });
        },
      },
    ]);

    await expect(
      tool.execute(
        "call-1",
        { command: "html.present", input: {} },
        new AbortController().signal,
        undefined,
        {
          sessionManager: {
            getSessionId: () => "session-1",
            getSessionFile: () => undefined,
            getLeafId: () => null,
            getBranch: () => [],
          },
        } as never,
      ),
    ).rejects.toThrow('EmptyTaggedError {"lineageId":"goal-header"}');
  });

  it("sends placeholder text for a stored empty tool error without rewriting history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cake-empty-tool-error-"));
    directories.push(cwd);
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir, { recursive: true });
    const requests: Message[][] = [];
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    runtime.registerProvider("empty-error-fixture", {
      api: "anthropic-messages",
      baseUrl: "https://empty-error-fixture.invalid",
      apiKey: "fixture",
      models: [
        {
          id: "fixture",
          name: "Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 1024,
        },
      ],
      streamSimple(model, context) {
        requests.push(structuredClone(context.messages));
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: "Done" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason: "stop",
          timestamp: 2,
        };
        queueMicrotask(() => {
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        });
        return stream;
      },
    });
    const model = runtime.getModel("empty-error-fixture", "fixture");
    if (!model) throw new Error("Missing fixture model");
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [emptyToolErrorExtension],
    });
    await loader.reload();
    const manager = SessionManager.inMemory(cwd);
    manager.appendMessage({ role: "user", content: "Show the header", timestamp: 1 });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "cake", arguments: {} }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason: "toolUse",
      timestamp: 1,
    });
    manager.appendMessage(toolResult([{ type: "text", text: "" }]));
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: manager,
      settingsManager: settings,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      noTools: "builtin",
    });
    await session.bindExtensions({});

    await session.prompt("Try again");

    const sent = requests[0]?.find((message) => message.role === "toolResult");
    expect(sent?.content).toEqual([{ type: "text", text: EMPTY_TOOL_ERROR_PLACEHOLDER }]);
    const stored = manager
      .getBranch()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []))
      .find((message) => message.role === "toolResult");
    expect(stored?.content).toEqual([{ type: "text", text: "" }]);
    session.dispose();
  });
});
