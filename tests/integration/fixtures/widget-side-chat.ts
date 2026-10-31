import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ModelRuntime, SessionManager, convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
  type Tool,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "../../../src/contracts/serialization/json-contract";
import { captureWidgetConversation } from "../../../src/services/pi/runtime/widget-conversation";

interface CapturedRequest {
  readonly messages: Message[];
  readonly payload: unknown;
  readonly sessionId: string | undefined;
}

export interface ScriptedReply {
  readonly content: AssistantMessage["content"];
  readonly stopReason?: AssistantMessage["stopReason"];
  readonly outputTokens?: number;
}

export const call = (id: string, name: string, args: Record<string, JsonValue>): ToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});
export const text = (value: string): ScriptedReply => ({
  content: [{ type: "text", text: value }],
});

const parameters = (properties: Record<string, JsonValue>, required: string[]) => ({
  type: "object",
  required,
  properties,
});

/** The tool declarations of a real Cake project session, as Pi records them. */
const parentTools: Tool[] = [
  {
    name: "read",
    description: "Read the contents of a file.",
    parameters: parameters(
      {
        path: { type: "string", description: "Path to the file to read (relative or absolute)" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read" },
      },
      ["path"],
    ),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  },
  {
    name: "bash",
    description: "Execute a bash command.",
    parameters: parameters({ command: { type: "string" } }, ["command"]),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
  },
  {
    name: "edit",
    description: "Edit a single file using exact text replacement.",
    parameters: parameters(
      {
        path: { type: "string" },
        edits: {
          type: "array",
          items: parameters({ oldText: { type: "string" }, newText: { type: "string" } }, [
            "oldText",
            "newText",
          ]),
        },
      },
      ["path", "edits"],
    ),
  },
  {
    name: "write",
    description: "Write content to a file.",
    parameters: parameters({ path: { type: "string" }, content: { type: "string" } }, [
      "path",
      "content",
    ]),
  },
  {
    name: "cake",
    description: "Use Cake controls when helpful.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" }, input: { type: "object" } },
      additionalProperties: false,
    },
  },
];

const usage = (output: number) => ({
  input: 0,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/**
 * A parent Cake conversation plus a scripted provider that records every
 * request the widget side chat makes through the real Pi runtime.
 */
export async function widgetSideChatFixture(script: (request: number) => ScriptedReply) {
  const cwd = await mkdtemp(join(tmpdir(), "cake-widget-side-chat-"));
  const agentDir = join(cwd, "agent");
  const skillDir = join(agentDir, "skills", "fixture");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: fixture\ndescription: Fixture widget instructions\n---\nRead the local template.\n",
  );
  await writeFile(join(skillDir, "template.tsx"), "domain-template-resource");
  await writeFile(join(cwd, "secret.txt"), "private-secret");
  const parentDir = join(cwd, "sessions");
  const sessionDir = join(cwd, "widgets");
  const requests: CapturedRequest[] = [];
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
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      },
    ],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const payload = await options?.onPayload?.({ prompt_cache_key: options.sessionId }, model);
        requests.push({
          messages: structuredClone(context.messages),
          payload,
          sessionId: options?.sessionId,
        });
        const reply = script(requests.length);
        const stopReason =
          reply.stopReason ??
          (reply.content.some((block) => block.type === "toolCall") ? "toolUse" : "stop");
        const message: AssistantMessage = {
          role: "assistant",
          content: reply.content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: usage(reply.outputTokens ?? 0),
          stopReason,
          timestamp: requests.length,
        };
        stream.push({ type: "start", partial: message });
        stream.push({
          type: "done",
          reason:
            stopReason === "toolUse" ? "toolUse" : stopReason === "length" ? "length" : "stop",
          message,
        });
        stream.end();
      })();
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
      preamble: "You are an expert coding assistant operating inside pi.",
      tools: "<tools>\n- read: Read file contents\n- write: Create or overwrite files\n</tools>",
      rules: "<rules>\n- Be concise in your responses\n</rules>",
      project_context: "<project_context>\nOnly verified revenue data.\n</project_context>",
      skills: `<skills>\n<skill><name>fixture</name><location>${join(skillDir, "SKILL.md")}</location></skill>\n</skills>`,
      cwd: `<cwd>\n${cwd}\n</cwd>`,
    },
    toolsAdded: parentTools,
    timestamp: 1,
  });
  parent.appendMessage({
    role: "user",
    content: "Use quarterly labels from our discussion.",
    timestamp: 1,
  });
  parent.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Agreed: Q1 to Q4." }],
    api: "openai-responses",
    provider: "widget-fixture",
    model: "vision",
    usage: usage(0),
    stopReason: "stop",
    timestamp: 1,
  });
  return {
    cwd,
    skillDir,
    parent,
    requests,
    /** Exactly what the parent's own next request would start with. */
    inherited: convertToLlm(parent.buildSessionContext().messages),
    origin: captureWidgetConversation({ sessionManager: parent }),
    options: {
      cwd,
      agentDir,
      sessionDir,
      sessionRoots: [parentDir, sessionDir],
      model: { provider: "widget-fixture", id: "vision" },
    },
    dispose: () => rm(cwd, { recursive: true, force: true }),
  };
}
