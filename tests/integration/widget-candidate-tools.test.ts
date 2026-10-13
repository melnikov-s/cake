import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Message,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { JsonValue } from "../../src/contracts/serialization/json-contract";
import { runInlineWidgetRepair } from "../../src/services/pi/runtime/sidecar-runtime";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("executes scoped candidate edits and skill reads through Pi, rejecting filesystem escape and invalid JSON without partial writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cake-candidate-tools-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  const skillDir = join(agentDir, "skills", "fixture");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: fixture\ndescription: Candidate fixture domain instructions\n---\nRead the local template.\n",
  );
  await writeFile(join(skillDir, "template.tsx"), "domain-template-resource");
  await writeFile(join(cwd, "secret.txt"), "private-secret");
  await symlink(join(cwd, "secret.txt"), join(skillDir, "escape.txt"));
  const requests: Message[][] = [];
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  const call = (id: string, name: string, args: Record<string, JsonValue>): ToolCall => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  runtime.registerProvider("candidate-fixture", {
    api: "openai-responses",
    baseUrl: "https://candidate.invalid",
    apiKey: "fixture",
    models: [
      {
        id: "vision",
        name: "Fixture",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      requests.push(structuredClone(context.messages));
      const content: AssistantMessage["content"] =
        requests.length === 1
          ? [
              call("skill", "read", { path: join(skillDir, "template.tsx") }),
              call("outside", "read", { path: join(cwd, "secret.txt") }),
              call("symlink", "read", { path: join(skillDir, "escape.txt") }),
            ]
          : requests.length === 2
            ? [
                call("source", "widget_edit", {
                  target: "source",
                  edits: [{ oldText: "Initial", newText: "Revised" }],
                }),
                call("invalid", "widget_edit", {
                  target: "state",
                  edits: [{ oldText: '"latest"', newText: "invalid-json" }],
                }),
                call("inspect", "widget_read", { target: "state" }),
                call("state", "widget_edit", {
                  target: "state",
                  edits: [{ oldText: '"latest"', newText: '"edited"' }],
                }),
              ]
            : [{ type: "text", text: "USE_STAGED_CANDIDATE" }];
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: requests.length < 3 ? "toolUse" : "stop",
        timestamp: requests.length,
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
      return stream;
    },
  });
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);
  const sessionDir = join(cwd, "widgets");
  const accepted = SessionManager.create(cwd, sessionDir);
  accepted.appendModelChange("candidate-fixture", "vision");
  accepted.appendMessage({ role: "user", content: "Accepted artifact context", timestamp: 1 });
  const originalLeaf = accepted.getLeafId();
  const candidate = {
    source: "export default function Chart(){return <div>Initial</div>}",
    state: { scene: "latest" },
  };
  const result = await runInlineWidgetRepair({
    cwd,
    agentDir,
    sessionDir,
    sessionRoots: [sessionDir],
    conversation: { type: "revision", sessionId: accepted.getSessionId() },
    language: "react",
    capability: "artifact",
    source: candidate.source,
    candidate,
    context: "Update the current scene",
    model: { provider: "candidate-fixture", id: "vision" },
  });
  expect(result.response).toContain("Revised");
  expect(result.sessionId).not.toBe(accepted.getSessionId());
  expect(accepted.getLeafId()).toBe(originalLeaf);
  expect(candidate.state).toEqual({ scene: "edited" });
  expect(
    getCurrentTools(requests[0]!)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["read", "widget_edit", "widget_read"]);
  expect(getCurrentSystemPrompt(requests[0]!)).toContain("Candidate fixture domain instructions");
  const messages = requests.at(-1)!;
  const results = messages.filter((message) => message.role === "toolResult");
  expect(results.find((message) => message.toolCallId === "skill")?.content).toEqual([
    { type: "text", text: "domain-template-resource" },
  ]);
  expect(results.filter((message) => message.isError).map((message) => message.toolCallId)).toEqual(
    ["outside", "symlink", "invalid"],
  );
  expect(
    JSON.stringify(results.find((message) => message.toolCallId === "inspect")?.content),
  ).toContain("latest");
  expect(JSON.stringify(results)).not.toContain("private-secret");
});
