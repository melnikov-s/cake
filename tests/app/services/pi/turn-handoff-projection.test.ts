import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createLiveMessageProjector,
  projectSessionEntries,
  turnHandoffEntryType,
  turnStopEntryType,
} from "../../../../src/services/pi/runtime/session-projection";

function assistant(text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    timestamp: 10,
    stopReason: "aborted",
    errorMessage: "Request was aborted",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function entries(text: string, handoff: boolean): SessionEntry[] {
  return [
    {
      type: "message",
      id: "assistant",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: assistant(text),
    },
    ...(handoff
      ? [
          {
            type: "custom" as const,
            id: "handoff",
            parentId: "assistant",
            timestamp: new Date(0).toISOString(),
            customType: turnHandoffEntryType,
            data: { timestamp: 10 },
          },
        ]
      : []),
  ];
}
describe("Intentional send-now handoff presentation", () => {
  it("suppresses live interruption errors but preserves partial output", () => {
    const project = createLiveMessageProjector({
      abortPresentation: () => ({ kind: "handoff" }),
    });
    expect(project({ type: "message_end", message: assistant() })).toEqual([]);
    expect(project({ type: "message_end", message: assistant("Partial work") })).toEqual([
      expect.objectContaining({ text: "Partial work", status: "complete" }),
    ]);
    const normal = createLiveMessageProjector();
    expect(normal({ type: "message_end", message: assistant() })).toEqual([
      expect.objectContaining({ kind: "notice", tone: "error" }),
    ]);
  });
  it("retains the handoff distinction when reopening the persisted Pi branch", () => {
    expect(projectSessionEntries(entries("", true))).toEqual([]);
    expect(projectSessionEntries(entries("Partial work", true))).toEqual([
      expect.objectContaining({ text: "Partial work", status: "complete" }),
    ]);
    expect(projectSessionEntries(entries("", false))).toEqual([
      expect.objectContaining({ title: "Model request failed", detail: "Request was aborted" }),
    ]);
    const failed = entries("", true);
    const entry = failed[0]!;
    if (entry.type === "message" && entry.message.role === "assistant")
      entry.message.stopReason = "error";
    expect(projectSessionEntries(failed)).toEqual([expect.objectContaining({ tone: "error" })]);
  });
});

describe("Deliberate stop presentation", () => {
  const stopEntry = (stop: unknown): SessionEntry => ({
    type: "custom",
    id: "stop",
    parentId: "assistant",
    timestamp: new Date(0).toISOString(),
    customType: turnStopEntryType,
    data: { timestamp: 10, stop },
  });

  it("shows an agent-initiated stop as a neutral notice naming the agent and reason", () => {
    const project = createLiveMessageProjector({
      abortPresentation: () => ({
        kind: "stopped",
        stop: { by: "session", sessionId: "cake-chat", title: "Cake Chat", reason: "user asked" },
      }),
    });
    expect(project({ type: "message_end", message: assistant("Partial work") })).toEqual([
      expect.objectContaining({ text: "Partial work", status: "complete" }),
      expect.objectContaining({
        kind: "notice",
        tone: "info",
        title: "Stopped",
        detail: "Stopped by Cake Chat (user asked)",
      }),
    ]);
  });

  it("keeps a user-initiated stop neutral when reopening the persisted Pi branch", () => {
    const parts = projectSessionEntries([...entries("", false), stopEntry({ by: "user" })]);
    expect(parts).toEqual([
      expect.objectContaining({ kind: "notice", tone: "info", detail: "Stopped by you" }),
    ]);
    expect(parts.some((part) => part.kind === "notice" && part.tone === "error")).toBe(false);
  });

  it("keeps an unexpected interruption or provider error as a failure", () => {
    expect(projectSessionEntries(entries("Partial work", false))).toEqual([
      expect.objectContaining({ text: "Partial work", status: "error" }),
    ]);
    const failed = [...entries("", false), stopEntry({ by: "user" })];
    const entry = failed[0]!;
    if (entry.type === "message" && entry.message.role === "assistant")
      entry.message.stopReason = "error";
    expect(projectSessionEntries(failed)).toEqual([
      expect.objectContaining({ tone: "error", title: "Model request failed" }),
    ]);
  });
});
