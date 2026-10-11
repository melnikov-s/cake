import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureWidgetConversation,
  prepareWidgetConversation,
} from "../../../src/services/pi/runtime/widget-conversation";
import { resolvePromptCacheLineageKey } from "../../../src/services/pi/runtime/prompt-cache-lineage";
import { runIsolatedSession } from "../../../src/services/pi/runtime/isolated-session-runner";
import {
  runInlineWidgetGeneration,
  runInlineWidgetRepair,
  runInlineWidgetVisualReview,
} from "../../../src/services/pi/runtime/sidecar-runtime";

vi.mock("../../../src/services/pi/runtime/isolated-session-runner", () => ({
  runIsolatedSession: vi.fn(),
}));
const run = vi.mocked(runIsolatedSession);
const directories: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "fixture",
  model: "vision",
  usage,
  stopReason: "stop",
  timestamp: 1,
});
const user = (manager: SessionManager, content: string) =>
  manager.appendMessage({ role: "user", content, timestamp: 1 });

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "cake-widget-branch-"));
  directories.push(cwd);
  const parentDir = join(cwd, "sessions");
  const sessionDir = join(cwd, "widgets");
  const parent = SessionManager.create(cwd, parentDir);
  parent.appendMessage({
    role: "system",
    content: "",
    sections: {
      preamble: "Parent instructions",
      project_context: "<project_context>\nVerified project requirements\n</project_context>",
      tools: "<tools>\nread, write\n</tools>",
      cwd: `<cwd>\n${cwd}\n</cwd>`,
    },
    toolsAdded: [
      { name: "write", description: "Write files", parameters: { type: "object", properties: {} } },
    ],
    timestamp: 1,
  });
  user(parent, "The chart must show verified facts only.");
  parent.appendMessage(assistant([{ type: "text", text: "Use the agreed labels." }]));
  return {
    parent,
    cwd,
    agentDir: join(cwd, "agent"),
    sessionDir,
    sessionRoots: [parentDir, sessionDir],
  };
}

afterEach(async () => {
  run.mockReset();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("widget conversation branches", () => {
  it("inherits the captured ancestor path, excluding siblings and later parent messages", async () => {
    const options = await fixture();
    const origin = captureWidgetConversation({ sessionManager: options.parent });
    user(options.parent, "Sibling-only facts");
    options.parent.branch(origin.entryId);
    user(options.parent, "Later parent decision");
    const parentFile = options.parent.getSessionFile();
    const parentLeaf = options.parent.getLeafId();
    const branch = await prepareWidgetConversation({
      ...options,
      conversation: { type: "parent", origin },
    });
    expect(branch.buildSessionContext().messages).toEqual(
      SessionManager.open(origin.sessionFile)
        .getBranch(origin.entryId)
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    );
    expect(branch.getSessionId()).not.toBe(origin.sessionId);
    expect(branch.getHeader()?.parentSession).toBe(origin.sessionFile);
    expect(options.parent.getSessionFile()).toBe(parentFile);
    expect(options.parent.getLeafId()).toBe(parentLeaf);
    expect(SessionManager.open(parentFile!).getLeafId()).toBe(parentLeaf);
  });

  it("cuts before an incomplete multi-tool batch but keeps completed earlier tool results", async () => {
    const options = await fixture();
    options.parent.appendMessage(
      assistant([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
    );
    options.parent.appendMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "Verified file contents" }],
      isError: false,
      timestamp: 1,
    });
    const complete = user(options.parent, "Create the artifact now");
    options.parent.appendMessage(
      assistant([
        { type: "toolCall", id: "sibling", name: "read", arguments: {} },
        { type: "toolCall", id: "generation", name: "cake", arguments: {} },
      ]),
    );
    options.parent.appendMessage({
      role: "toolResult",
      toolCallId: "sibling",
      toolName: "read",
      content: [{ type: "text", text: "In-flight sibling result" }],
      isError: false,
      timestamp: 1,
    });
    const branch = await prepareWidgetConversation({
      ...options,
      conversation: {
        type: "parent",
        origin: captureWidgetConversation({ sessionManager: options.parent }),
      },
    });
    const context = branch.buildSessionContext().messages;
    expect(JSON.stringify(context)).toContain("Verified file contents");
    expect(JSON.stringify(context)).not.toContain("In-flight sibling result");
    expect(branch.getBranch().find((entry) => entry.type === "custom")?.parentId).toBe(complete);
  });

  it("keeps a completed tool batch instead of trimming every tool-using assistant", async () => {
    const options = await fixture();
    options.parent.appendMessage(
      assistant([{ type: "toolCall", id: "read", name: "read", arguments: {} }]),
    );
    options.parent.appendMessage({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "Complete result" }],
      isError: false,
      timestamp: 1,
    });
    const origin = captureWidgetConversation({ sessionManager: options.parent });
    const branch = await prepareWidgetConversation({
      ...options,
      conversation: { type: "parent", origin },
    });
    expect(JSON.stringify(branch.buildSessionContext().messages)).toContain("Complete result");
    expect(branch.getEntry(origin.entryId)).toBeDefined();
  });

  it("uses Pi's compaction and branch-local context edits", async () => {
    const options = await fixture();
    const retained = user(options.parent, "Original retained instruction");
    options.parent.appendCompaction("Agreed chart requirements", retained, 10000);
    options.parent.appendContextEdit(retained, { content: "Corrected retained instruction" });
    const expected = options.parent.buildSessionContext().messages;
    const branch = await prepareWidgetConversation({
      ...options,
      conversation: {
        type: "parent",
        origin: captureWidgetConversation({ sessionManager: options.parent }),
      },
    });
    expect(branch.buildSessionContext().messages).toEqual(expected);
    expect(JSON.stringify(expected)).toContain("Agreed chart requirements");
    expect(JSON.stringify(expected)).toContain("Corrected retained instruction");
    expect(JSON.stringify(expected)).not.toContain("Original retained instruction");
  });

  it("resumes private work after restart and forks revisions without changing the accepted baseline", async () => {
    const options = await fixture();
    const first = await prepareWidgetConversation({
      ...options,
      conversation: {
        type: "parent",
        origin: captureWidgetConversation({ sessionManager: options.parent }),
      },
    });
    user(first, "Build Artifact A");
    first.appendMessage(assistant([{ type: "text", text: "Accepted Artifact A" }]));
    const firstFile = first.getSessionFile()!;
    const firstLeaf = first.getLeafId();
    const continued = await prepareWidgetConversation({
      ...options,
      conversation: { type: "continue", sessionId: first.getSessionId() },
    });
    expect(continued.getSessionFile()).toBe(firstFile);
    const second = await prepareWidgetConversation({
      ...options,
      cwd: join(options.cwd, "another-worktree"),
      conversation: { type: "revision", sessionId: first.getSessionId() },
    });
    user(second, "Change the labels");
    expect(second.getSessionId()).not.toBe(first.getSessionId());
    expect(JSON.stringify(second.buildSessionContext().messages)).toContain("Accepted Artifact A");
    expect(SessionManager.open(firstFile).getLeafId()).toBe(firstLeaf);
    await expect(
      resolvePromptCacheLineageKey({ sessionManager: second, sessionRoots: options.sessionRoots }),
    ).resolves.toBe(options.parent.getSessionId());
  });

  it("fails rather than silently creating a context-free session for missing or mismatched origins", async () => {
    const options = await fixture();
    const origin = captureWidgetConversation({ sessionManager: options.parent });
    await expect(
      prepareWidgetConversation({
        ...options,
        conversation: { type: "parent", origin: { ...origin, entryId: "missing" } },
      }),
    ).rejects.toThrow("branch point");
    await expect(
      prepareWidgetConversation({
        ...options,
        conversation: { type: "parent", origin: { ...origin, sessionId: "other" } },
      }),
    ).rejects.toThrow("identity");
    await expect(
      prepareWidgetConversation({
        ...options,
        sessionRoots: [options.sessionDir],
        conversation: { type: "parent", origin },
      }),
    ).rejects.toThrow("outside");
    await expect(
      prepareWidgetConversation({
        ...options,
        conversation: { type: "revision", sessionId: "missing" },
      }),
    ).rejects.toThrow("no longer available");
  });

  it("generation, repair and screenshot review use the same persisted branch and restricted runtime", async () => {
    const options = await fixture();
    run.mockImplementation(async (input) => {
      const manager = input.sessionManager;
      expect(input).toMatchObject({
        inheritWidgetContext: true,
        promptCacheSessionRoots: options.sessionRoots,
        projectTrusted: false,
        noTools: "all",
      });
      expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
        "verified facts only",
      );
      user(manager, input.prompt);
      manager.appendMessage(assistant([{ type: "text", text: "Generated output" }]));
      return {
        sessionId: manager.getSessionId(),
        sessionFile: manager.getSessionFile(),
        response: "Generated output",
      };
    });
    const generated = await runInlineWidgetGeneration({
      ...options,
      conversation: {
        type: "parent",
        origin: captureWidgetConversation({ sessionManager: options.parent }),
      },
      brief: "Create a chart",
      fallback: "Chart",
    });
    const conversation = { type: "continue" as const, sessionId: generated.sessionId };
    const repaired = await runInlineWidgetRepair({
      ...options,
      conversation,
      source: "source",
      context: "chart",
      language: "react",
      capability: "display",
    });
    const reviewed = await runInlineWidgetVisualReview({
      ...options,
      conversation,
      source: "source",
      context: "chart",
      diagnostic: "readable",
      pngBase64: "cG5n",
      model: { provider: "fixture", id: "vision" },
    });
    expect(repaired.sessionId).toBe(generated.sessionId);
    expect(reviewed.sessionId).toBe(generated.sessionId);
    expect(reviewed.sessionFile).toBe(generated.sessionFile);
    expect(
      run.mock.calls[2]![0].sessionManager.getBranch().filter(
        (entry) => entry.type === "message" && entry.message.role === "user",
      ),
    ).toHaveLength(4);
  });
});
