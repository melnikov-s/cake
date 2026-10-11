import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";
import {
  toolCompactProvenanceEntryType,
  toolCompactProvenanceSchema,
} from "../../../src/services/pi/runtime/tool-compaction-provenance";
import { Schema } from "effect";
import { addResponseModeReminder } from "../../../src/contracts/conversations/response-mode-reminders";
import { addPresentationModeReminder } from "../../../src/contracts/conversations/presentation-mode-reminders";
import { projectConversationDisplay } from "../../../src/services/pi/runtime/conversation-display-projection";

const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("tool compaction", () => {
  it("adds a clean root branch while preserving the Session ID and original tree", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-tool-compact-"));
    temporaryDirectories.push(sessionDir);
    const session = SessionManager.create("/project", sessionDir);
    const originalUserId = session.appendMessage({
      role: "user",
      content: "Investigate this",
      timestamp: 1,
    });
    const firstAssistantId = session.appendMessage(
      assistant([
        { type: "text", text: "I will inspect it." },
        { type: "thinking", thinking: "private analysis" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.ts" } },
      ]),
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "large result" }],
      isError: false,
      timestamp: 2,
    });
    const selectedId = session.appendMessage(
      assistant([{ type: "text", text: "The investigation report." }]),
    );
    const originalSessionId = session.getSessionId();
    const originalSessionFile = session.getSessionFile();

    const result = appendToolCompactedBranch(session, selectedId, {
      provider: "openai",
      modelId: "gpt-test",
      thinkingLevel: "high",
    });

    expect(result).toMatchObject({
      sessionId: originalSessionId,
      sessionFile: originalSessionFile,
    });
    expect(session.getTree()).toHaveLength(2);
    expect(session.getTree()[0]?.entry.id).toBe(originalUserId);
    const activeBranch = session.getBranch();
    expect(activeBranch[0]).toMatchObject({
      type: "custom",
      customType: "cake.tool-compact/v1",
      parentId: null,
    });
    const provenanceEntry = activeBranch.find(
      (entry) => entry.type === "custom" && entry.customType === toolCompactProvenanceEntryType,
    );
    expect(provenanceEntry?.type).toBe("custom");
    const provenance = Schema.decodeUnknownSync(toolCompactProvenanceSchema)(
      provenanceEntry?.type === "custom" ? provenanceEntry.data : undefined,
    );
    expect(provenance).toMatchObject({
      sourceLeafId: selectedId,
      markerEntryId: activeBranch[0]?.id,
      replayStartEntryId: provenance.mappings[0]?.replayedEntryId,
      replayEndEntryId: provenance.mappings.at(-1)?.replayedEntryId,
    });
    expect(provenance.mappings.map((mapping) => mapping.sourceEntryId)).toEqual([
      originalUserId,
      firstAssistantId,
      selectedId,
    ]);
    expect(new Set(provenance.mappings.map((mapping) => mapping.replayedEntryId)).size).toBe(3);

    const context = session.buildSessionContext();
    expect(JSON.stringify(context.messages)).not.toContain(toolCompactProvenanceEntryType);
    expect(JSON.stringify(context.messages)).not.toContain("sourceLeafId");
    expect(JSON.stringify(context.messages)).not.toContain("toolCall");
    expect(JSON.stringify(context.messages)).not.toContain("large result");
    expect(JSON.stringify(context.messages)).not.toContain("private analysis");
    expect(context.model).toEqual({ provider: "openai", modelId: "gpt-test" });
    expect(context.thinkingLevel).toBe("high");
    expect(
      activeBranch[0]?.type === "custom"
        ? (activeBranch[0].data as { summary: string }).summary
        : undefined,
    ).toContain("full original transcript remains available in the session tree");
  });

  it("preserves the canonical system baseline while stripping reminders from multimodal dialogue", () => {
    const session = SessionManager.inMemory("/project");
    session.appendMessage({
      role: "system",
      content: "",
      sections: { rules: "Required canonical instructions" },
      timestamp: 0,
    });
    const literal = "<system-reminder>User-authored guidance.</system-reminder>";
    const decorate = (text: string) =>
      addResponseModeReminder(addPresentationModeReminder(text, "normal", "draw"), "voice");
    session.appendMessage({
      role: "user",
      content: decorate(`Question\n\n${literal}`),
      timestamp: 1,
    });
    session.appendMessage({ role: "user", content: decorate(""), timestamp: 2 });
    session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: decorate("Describe this") },
        { type: "image", mimeType: "image/png", data: "image" },
      ],
      timestamp: 3,
    });
    session.appendCustomMessageEntry("cake.context", "Hidden injected context", false);
    session.appendCustomMessageEntry("extension.context", "Visible injected context", true);
    const leaf = session.appendMessage(
      assistant([
        { type: "thinking", thinking: "analysis" },
        { type: "text", text: "Answer" },
      ]),
    );
    appendToolCompactedBranch(session, leaf);
    const messages = session.buildSessionContext().messages;
    expect(messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toMatchObject({ sections: { rules: "Required canonical instructions" } });
    expect(messages[1]).toMatchObject({ content: `Question\n\n${literal}` });
    expect(messages[2]).toMatchObject({
      content: [
        { type: "text", text: "Describe this" },
        { type: "image", data: "image" },
      ],
    });
    expect(messages[3]).toMatchObject({ content: [{ type: "text", text: "Answer" }] });
    expect(JSON.stringify(messages)).not.toContain("Cake response mode");
    expect(JSON.stringify(messages)).not.toContain("entered Draw");
    expect(JSON.stringify(messages)).not.toContain("injected context");
    expect(JSON.stringify(messages)).toContain("Required canonical instructions");
    expect(JSON.stringify(messages)).not.toContain("tool-compacted continuation");
    expect(projectConversationDisplay(session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "context",
          title: "Cake · response mode",
          origin: "compacted",
        }),
        expect.objectContaining({
          kind: "context",
          title: "cake.context",
          text: "Hidden injected context",
          origin: "compacted",
        }),
        expect.objectContaining({ kind: "text", role: "assistant", text: "Answer" }),
      ]),
    );
    session.appendMessage({ role: "user", content: "Continue", timestamp: 4 });
    const nextLeaf = session.appendMessage(assistant([{ type: "text", text: "Next answer" }]));
    appendToolCompactedBranch(session, nextLeaf);
    expect(session.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(
      projectConversationDisplay(session).filter((part) => part.kind === "context"),
    ).toHaveLength(9);
  });

  it("carries the selected branch's folded Pi checkpoint without projecting another injection", () => {
    const session = SessionManager.inMemory("/project");
    const tool = (name: string) => ({ name, description: name, parameters: { type: "object" } });
    session.appendMessage({
      role: "system",
      content: "Canonical preamble",
      sections: { rules: "Original rules", obsolete: "Remove this section" },
      toolsAdded: [tool("read"), tool("write")],
      timestamp: 0,
    });
    const userId = session.appendMessage({ role: "user", content: "Question", timestamp: 1 });
    session.appendMessage({
      role: "system",
      content: "",
      sections: { rules: "Current rules", obsolete: null },
      toolsRemoved: [{ name: "write" }],
      timestamp: 2,
    });
    session.appendCompaction("Normal summary", userId, 100);
    session.appendCustomMessageEntry("extension.reminder", "Remove this reminder", false);
    const selectedId = session.appendMessage(assistant([{ type: "text", text: "Answer" }]));
    // Compaction at a selected earlier response must not capture later instructions.
    session.appendMessage({
      role: "system",
      content: "",
      sections: { rules: "Later rules" },
      timestamp: 3,
    });

    appendToolCompactedBranch(session, selectedId);
    const checkpoint = session.buildSessionContext().messages[0];
    expect(checkpoint).toMatchObject({
      role: "system",
      content: "Canonical preamble",
      sections: { rules: "Current rules" },
      toolsAdded: [tool("read")],
    });
    expect(JSON.stringify(checkpoint)).not.toContain("obsolete");
    expect(JSON.stringify(session.buildSessionContext().messages)).not.toContain(
      "Remove this reminder",
    );
    const parts = projectConversationDisplay(session);
    expect(
      parts.filter((part) => part.kind === "context" && part.title === "System prompt"),
    ).toHaveLength(2);
    expect(
      parts.filter((part) => part.kind === "context").every((part) => part.origin === "compacted"),
    ).toBe(true);

    const nextId = session.appendMessage(assistant([{ type: "text", text: "Next answer" }]));
    appendToolCompactedBranch(session, nextId);
    expect(
      session.buildSessionContext().messages.filter((message) => message.role === "system"),
    ).toEqual([checkpoint]);
    expect(
      projectConversationDisplay(session).filter(
        (part) => part.kind === "context" && part.title === "System prompt",
      ),
    ).toHaveLength(2);
    // A genuine post-compaction change is still visible, not mistaken for the checkpoint.
    session.appendMessage({
      role: "system",
      content: "",
      sections: { rules: "Changed rules" },
      timestamp: 4,
    });
    expect(projectConversationDisplay(session)).toContainEqual(
      expect.objectContaining({
        kind: "context",
        title: "System prompt",
        text: expect.stringContaining("Changed rules"),
      }),
    );
  });

  it("rejects non-assistant targets", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-tool-compact-"));
    temporaryDirectories.push(sessionDir);
    const session = SessionManager.create("/project", sessionDir);
    const userId = session.appendMessage({ role: "user", content: "Question", timestamp: 1 });

    expect(() => appendToolCompactedBranch(session, userId)).toThrow(
      "Tool compaction requires a completed assistant response",
    );
  });
});
