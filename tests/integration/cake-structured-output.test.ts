import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../src/contracts/serialization/json-contract";
import { createCakeArtifactOperations } from "../../src/domain/artifacts/cake-artifact-operations";
import { createCakeToolDefinition } from "../../src/services/pi/runtime/cake-session-runtime-capabilities";
import { shutdownCakeSessionExtensions } from "../../src/services/pi/runtime/cake-session-runtime-resources";
import { artifactMetadata, artifactOperationOptions } from "../fixtures/cake-structured-output";

const directories: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.abort();
    await shutdownCakeSessionExtensions(session);
    session.dispose();
  }
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function harness() {
  const cwd = await mkdtemp(join(tmpdir(), "cake-structured-output-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  const list = vi.fn(async () => [artifactMetadata()]);
  const settingsManager = SettingsManager.inMemory({
    defaultTools: ["cake", "codemode"],
    retry: { enabled: false },
    compaction: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      createCodemodeExtension({ mode: "on" }),
      (pi) =>
        pi.registerTool(
          createCakeToolDefinition(
            createCakeArtifactOperations(pi, artifactOperationOptions(list)),
          ),
        ),
    ],
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => true });
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  sessions.push(session);
  await session.bindExtensions({});
  const selectedModel = session.modelRuntime.getModel("openai", "gpt-4.1-mini");
  if (!selectedModel) throw new Error("Fixture model missing");
  const model = selectedModel;
  await session.modelRuntime.setRuntimeApiKey("openai", "fixture");
  await session.setModel(model);

  async function invoke(name: string, args: JsonObject) {
    let first = true;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: first
          ? [{ type: "toolCall", id: "fixture-call", name, arguments: args }]
          : [{ type: "text", text: "Done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: 0,
      };
      first = false;
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
      return stream;
    };
    const previous = session.messages.length;
    // Pi's native structured value is transient execution data, not a transcript field.
    let structuredContent: JsonValue | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "fixture-call") {
        structuredContent = Schema.decodeUnknownSync(
          Schema.Struct({
            structuredContent: Schema.optionalKey(jsonValueSchema),
          }),
        )(event.result).structuredContent;
      }
    });
    try {
      await session.prompt("Fixture tool request");
      const result = session.messages
        .slice(previous)
        .find((message) => message.role === "toolResult");
      if (!result || result.role !== "toolResult") throw new Error("Expected tool result");
      return { ...result, structuredContent };
    } finally {
      unsubscribe();
    }
  }
  return { session, list, invoke, script: (code: string) => invoke("codemode", { code }) };
}

function textOf(result: { content: ({ type: "text"; text: string } | { type: "image" })[] }) {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

describe("Cake structured output through real Pi codemode", () => {
  it("uses native structuredContent for fields, retains readable direct results, and describes the honest union", async () => {
    const h = await harness();
    const direct = await h.invoke("cake", { command: "artifacts.list" });
    expect(direct.isError).toBe(false);
    expect(textOf(direct)).toContain('"lineageId": "design-plan"');
    expect(direct.structuredContent).toEqual({
      command: "artifacts.list",
      result: { total: 1, truncated: false, artifacts: [artifactMetadata()] },
    });

    const scripted = await h.script(`
      const list = await tools.cake({command: "artifacts.list"});
      const search = await tools.cake({command: "artifacts.search", input: {query: "DESIGN"}});
      const resolved = await tools.cake({command: "artifacts.resolve-reference", input: {reference: search.result.artifacts[0].exactRef}});
      return {total: list.result.total, command: resolved.command, path: resolved.result.files[0].path, revision: resolved.result.selectedRevision};
    `);
    expect(scripted.isError).toBe(false);
    expect(textOf(scripted)).toContain('"total":1');
    expect(textOf(scripted)).toContain('"command":"artifacts.resolve-reference"');
    expect(textOf(scripted)).toContain('"path":"/cache/design-plan/r2/content.md"');
    expect(textOf(scripted)).toContain('"revision":2');
    const described = await h.script(`return await describeTool("cake");`);
    expect(described.isError).toBe(false);
    expect(textOf(described)).toContain("Promise<string |");
    expect(textOf(described)).toContain("artifacts.search");
    expect(textOf(described)).toContain("selectedRevision: number");
  });

  it("keeps help, unknown commands, and nonselected operations as the original strings", async () => {
    const h = await harness();
    const result = await h.script(`
      const values = await Promise.all([
        tools.cake({}), tools.cake({command: "artifacts"}),
        tools.cake({command: "artifacts.search.help"}), tools.cake({command: "unknown"}),
        tools.cake({command: "artifacts.history", input: {lineageId: "design-plan"}})
      ]);
      return values.map(value => typeof value);
    `);
    expect(result.isError).toBe(false);
    expect(textOf(result)).toContain('["string","string","string","string","string"]');
    expect(h.list).not.toHaveBeenCalled();
    const history = await h.script(
      `return await tools.cake({command: "artifacts.history", input: {lineageId: "design-plan"}});`,
    );
    expect(history.isError).toBe(false);
    expect(textOf(history)).toContain('"revisions"');
  });

  it("passes full machine data beyond readable truncation and rejects data exceeding the result budget", async () => {
    const h = await harness();
    h.list.mockResolvedValueOnce([{ ...artifactMetadata(), title: "x".repeat(30_000) }]);
    const fullData = await h.script(
      `const value = await tools.cake({command: "artifacts.list"}); return {length: value.result.artifacts[0].title.length};`,
    );
    expect(fullData.isError).toBe(false);
    expect(textOf(fullData)).toContain('"length":30000');
    h.list.mockResolvedValueOnce([{ ...artifactMetadata(), title: "x".repeat(1_048_576) }]);
    const oversized = await h.script(`await tools.cake({command: "artifacts.list"});`);
    expect(oversized.isError).toBe(true);
    expect(textOf(oversized)).toContain("1048576-byte result limit");
  });

  it("rejects malformed authority output, invalid input, and domain errors through the native nested-call pipeline", async () => {
    const h = await harness();
    h.list.mockResolvedValueOnce([
      { ...artifactMetadata(), selectedRevision: "bad" } as unknown as ReturnType<
        typeof artifactMetadata
      >,
    ]);
    const invalidOutput = await h.script(
      `await tools.cake({command: "artifacts.list"}); return "SHOULD NOT RETURN";`,
    );
    expect(invalidOutput.isError).toBe(true);
    expect(textOf(invalidOutput)).toContain("selectedRevision");
    expect(textOf(invalidOutput)).not.toContain("SHOULD NOT RETURN");
    h.list.mockClear();
    const input = await h.script(
      `try { await tools.cake({command: "artifacts.search", input: {query: "design", limit: 51}}); } catch (error) { return {rejected: true, error: error.message}; }`,
    );
    expect(input.isError).toBe(false);
    expect(textOf(input)).toContain('"rejected":true');
    expect(h.list).not.toHaveBeenCalled();
    const error = await h.script(
      `await tools.cake({command: "artifacts.resolve-reference", input: {reference: "missing"}});`,
    );
    expect(error.isError).toBe(true);
    expect(textOf(error)).toContain("Artifact is not linked");
    const direct = await h.invoke("cake", {
      command: "artifacts.resolve-reference",
      input: { reference: "missing" },
    });
    expect(direct.isError).toBe(true);
    expect(direct.structuredContent).toBeUndefined();
  });
});
