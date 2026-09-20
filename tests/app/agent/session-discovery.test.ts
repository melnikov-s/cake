import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  cakeWorkspaceSessionDirectory,
  loadWorkspacePiSessionPreview,
} from "../../../src/services/pi/runtime/session-discovery";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";

const usage: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], model = "fixture"): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model,
    usage,
    stopReason: "stop",
    timestamp: 2,
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("loadWorkspacePiSessionPreview", () => {
  it("reconstructs compacted work logs from a resolved Pi transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-preview-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const activeSessionRoot = join(root, "sessions");
    const resolvedSessionRoot = join(root, "resolved-sessions");
    const manager = SessionManager.create(
      cwd,
      cakeWorkspaceSessionDirectory(cwd, resolvedSessionRoot),
    );

    manager.appendMessage({ role: "user", content: "Inspect the project", timestamp: 1 });
    manager.appendMessage(
      assistant([
        { type: "thinking", thinking: "historical reasoning" },
        {
          type: "toolCall",
          id: "historical-read",
          name: "read",
          arguments: { path: "src/old.ts" },
        },
        { type: "text", text: "I inspected the old file." },
      ]),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "historical-read",
      toolName: "read",
      content: [{ type: "text", text: "historical output" }],
      isError: false,
      timestamp: 3,
    });
    const sourceLeafId = manager.appendMessage(
      assistant([{ type: "text", text: "Original answer." }]),
    );
    appendToolCompactedBranch(manager, sourceLeafId);

    manager.appendMessage({ role: "user", content: "Check the current file", timestamp: 4 });
    manager.appendMessage(
      assistant(
        [
          { type: "thinking", thinking: "current reasoning" },
          {
            type: "toolCall",
            id: "current-read",
            name: "read",
            arguments: { path: "src/current.ts" },
          },
        ],
        "current-model",
      ),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "current-read",
      toolName: "read",
      content: [{ type: "text", text: "current output" }],
      isError: false,
      timestamp: 5,
    });
    manager.appendMessage(assistant([{ type: "text", text: "Current answer." }], "current-model"));

    const preview = await loadWorkspacePiSessionPreview(
      cwd,
      manager.getSessionId(),
      activeSessionRoot,
      resolvedSessionRoot,
    );

    expect(preview?.sessionFile).toBe(manager.getSessionFile());
    expect(preview?.currentModel).toEqual({ provider: "openai", modelId: "current-model" });
    expect(
      preview?.parts.find(
        (part) => part.kind === "reasoning" && part.text === "historical reasoning",
      ),
    ).toMatchObject({ origin: "compacted" });
    expect(
      preview?.parts.find((part) => part.kind === "tool" && part.id === "tool-historical-read"),
    ).toMatchObject({ origin: "compacted", output: "historical output", state: "success" });
    expect(
      preview?.parts.find((part) => part.kind === "reasoning" && part.text === "current reasoning"),
    ).not.toHaveProperty("origin");
    expect(
      preview?.parts.find((part) => part.kind === "tool" && part.id === "tool-current-read"),
    ).toMatchObject({ output: "current output", state: "success" });
    expect(
      preview?.parts.find((part) => part.kind === "tool" && part.id === "tool-current-read"),
    ).not.toHaveProperty("origin");
  });
});
