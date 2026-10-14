import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Stream } from "effect";
import {
  cakeWorkspaceSessionDirectory,
  forkWorkspaceSession,
  loadWorkspacePiSessionPreview,
  streamWorkspaceSessions,
} from "../../../src/services/pi/runtime/session-discovery";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";
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
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("loadWorkspacePiSessionPreview", () => {
  it("filters resolved IDs before opening transcripts for catalog titles", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-title-filter-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const sessionRoot = join(root, "sessions");
    const directory = cakeWorkspaceSessionDirectory(cwd, sessionRoot);
    const active = SessionManager.create(cwd, directory);
    active.appendMessage({ role: "user", content: "Active work", timestamp: 1 });
    const resolved = SessionManager.create(cwd, directory);
    resolved.appendMessage({ role: "user", content: "Resolved work", timestamp: 2 });
    const open = vi.spyOn(SessionManager, "open");
    const catalog = await Effect.runPromise(
      streamWorkspaceSessions(cwd, sessionRoot, {
        excludedSessionIds: [resolved.getSessionId()],
      }).pipe(Stream.runCollect),
    );
    expect(catalog.map((item) => item.id)).toEqual([active.getSessionId()]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(active.getSessionFile());
  });
  it("skips an unreadable transcript without hiding the directory's other sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-unreadable-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const sessionRoot = join(root, "sessions");
    const directory = cakeWorkspaceSessionDirectory(cwd, sessionRoot);
    const sessions = ["First work", "Second work"].map((content, index) => {
      const manager = SessionManager.create(cwd, directory);
      manager.appendMessage({ role: "user", content, timestamp: index + 1 });
      return manager.getSessionId();
    });
    // A transcript tail without its session header, as found on disk.
    await writeFile(
      join(directory, "2026-09-01T15-09-02-711Z_01a05d84-3d77-7e1b-beaa-dd6dab584e42.jsonl"),
      `${JSON.stringify({ type: "message", id: "d8c94a21", parentId: "a94f94fc" })}\n`,
    );
    const catalog = await Effect.runPromise(
      streamWorkspaceSessions(cwd, sessionRoot).pipe(Stream.runCollect),
    );
    expect(catalog.map((item) => item.id).sort()).toEqual([...sessions].sort());
  });
  it("reconstructs compacted work logs from a persisted Pi transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-session-preview-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const activeSessionRoot = join(root, "sessions");
    const manager = SessionManager.create(
      cwd,
      cakeWorkspaceSessionDirectory(cwd, activeSessionRoot),
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

  it("preserves compacted display work through a fork and reopen without adding model context", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-fork-display-provenance-"));
    temporaryDirectories.push(root);
    const cwd = join(root, "project");
    const activeSessionRoot = join(root, "sessions");
    const manager = SessionManager.create(
      cwd,
      cakeWorkspaceSessionDirectory(cwd, activeSessionRoot),
    );

    manager.appendMessage({
      role: "system",
      content: "",
      sections: { rules: "Canonical instructions" },
      timestamp: 0,
    });
    manager.appendMessage({ role: "user", content: "Inspect the old file", timestamp: 1 });
    manager.appendMessage(
      assistant([
        { type: "thinking", thinking: "historical reasoning" },
        {
          type: "toolCall",
          id: "historical-read",
          name: "read",
          arguments: { path: "src/old.ts" },
        },
      ]),
    );
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "historical-read",
      toolName: "read",
      content: [{ type: "text", text: "historical output" }],
      isError: false,
      timestamp: 2,
    });
    const sourceLeafId = manager.appendMessage(
      assistant([{ type: "text", text: "Old inspection complete." }]),
    );
    appendToolCompactedBranch(manager, sourceLeafId);
    manager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
    const forkLeafId = manager.appendMessage(
      assistant([{ type: "text", text: "Ready to continue." }]),
    );

    const compactedDisplay = projectConversationDisplay(manager);
    expect(
      compactedDisplay.find((part) => part.kind === "tool" && part.id === "tool-historical-read"),
    ).toMatchObject({ origin: "compacted", output: "historical output" });

    const replayedAnswer = compactedDisplay.find(
      (part) => part.kind === "text" && part.text === "Old inspection complete.",
    );
    expect(replayedAnswer?.kind).toBe("text");
    if (replayedAnswer?.kind !== "text" || !replayedAnswer.entryId)
      throw new Error("The compacted replay fixture is incomplete");

    const sourceFile = manager.getSessionFile();
    if (!sourceFile) throw new Error("The persisted source fixture has no session file");
    const replayedAnswerCwd = join(root, "replayed-answer-project");
    const replayedAnswerFork = forkWorkspaceSession(
      sourceFile,
      cwd,
      replayedAnswer.entryId,
      replayedAnswerCwd,
      activeSessionRoot,
      "Fork at replayed answer",
    );
    const replayedAnswerSession = SessionManager.open(
      replayedAnswerFork.sessionFile!,
      cakeWorkspaceSessionDirectory(replayedAnswerCwd, activeSessionRoot),
      replayedAnswerCwd,
    );
    expect(
      projectConversationDisplay(replayedAnswerSession).find(
        (part) => part.kind === "tool" && part.id === "tool-historical-read",
      ),
    ).toMatchObject({ origin: "compacted", output: "historical output" });
    expect(JSON.stringify(replayedAnswerSession.buildSessionContext().messages)).not.toContain(
      "historical output",
    );
    // Forking inside replayed dialogue keeps the canonical checkpoint but not a new pill.
    expect(JSON.stringify(replayedAnswerSession.buildSessionContext().messages)).toContain(
      "Canonical instructions",
    );
    expect(
      projectConversationDisplay(replayedAnswerSession).filter(
        (part) => part.kind === "context" && part.title === "System",
      ),
    ).toHaveLength(0);

    const fork = forkWorkspaceSession(
      manager.getSessionFile()!,
      cwd,
      forkLeafId,
      cwd,
      activeSessionRoot,
      "Forked compacted session",
    );
    const forked = SessionManager.open(
      fork.sessionFile!,
      cakeWorkspaceSessionDirectory(cwd, activeSessionRoot),
      cwd,
    );
    expect(
      projectConversationDisplay(forked).find(
        (part) => part.kind === "tool" && part.id === "tool-historical-read",
      ),
    ).toMatchObject({ origin: "compacted", output: "historical output" });
    expect(JSON.stringify(forked.buildSessionContext().messages)).not.toContain(
      "historical output",
    );

    const reopened = await loadWorkspacePiSessionPreview(cwd, fork.sessionId, activeSessionRoot);
    expect(
      reopened?.parts.find((part) => part.kind === "tool" && part.id === "tool-historical-read"),
    ).toMatchObject({ origin: "compacted", output: "historical output" });
  });
});
