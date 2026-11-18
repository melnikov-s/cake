import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { settledSessionActivity } from "../../../../src/renderer/lib/session-activity";
import { createLiveMessageProjector } from "../../../../src/services/pi/runtime/message-projection";
import {
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
      expect.objectContaining({ kind: "notice", tone: "info", title: "Turn interrupted" }),
    ]);
  });
  it("retains the handoff distinction when reopening the persisted Pi branch", () => {
    expect(projectSessionEntries(entries("", true))).toEqual([]);
    expect(projectSessionEntries(entries("Partial work", true))).toEqual([
      expect.objectContaining({ text: "Partial work", status: "complete" }),
    ]);
    const failedParts = projectSessionEntries(entries("", false));
    expect(failedParts).toEqual([
      expect.objectContaining({ title: "Turn interrupted", tone: "info" }),
    ]);
    expect(settledSessionActivity("aborted", failedParts)).toBe("error");
    expect(settledSessionActivity(undefined, failedParts)).toBe("error");
  });
  it("hides the error stop an abort during a tool surfaces, only for a handoff", () => {
    const abortedRequest = { ...assistant(), stopReason: "error" as const };
    abortedRequest.errorMessage = "This operation was aborted";
    expect(
      createLiveMessageProjector({ abortPresentation: () => ({ kind: "handoff" }) })({
        type: "message_end",
        message: abortedRequest,
      }),
    ).toEqual([]);
    const persisted = (handoff: boolean) => {
      const projected = entries("", handoff);
      const entry = projected[0]!;
      if (entry.type === "message") entry.message = abortedRequest;
      return projectSessionEntries(projected);
    };
    expect(persisted(true)).toEqual([]);
    expect(persisted(false)).toEqual([
      expect.objectContaining({ tone: "info", title: "Turn interrupted" }),
    ]);
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

  it.each(["aborted", "error"] as const)(
    "projects a deliberate %s cancellation live and on reopen",
    (stopReason) => {
      const source = {
        title: "Cake / Project Chat",
        href: `cake://session/project-chat%3A${"a".repeat(64)}`,
      };
      const stop = { by: "conversation", source, reason: "Changed direction" } as const;
      const project = createLiveMessageProjector({
        abortPresentation: () => ({ kind: "stopped", stop }),
        deferProviderErrors: true,
      });
      const message = {
        ...assistant("Partial work"),
        stopReason,
        errorMessage: "This operation was aborted",
      };
      const expected = [
        expect.objectContaining({ text: "Partial work", status: "complete" }),
        expect.objectContaining({
          kind: "notice",
          tone: "info",
          title: "Stopped",
          stopSource: source,
          detail: "Changed direction",
        }),
      ];
      expect(project({ type: "message_end", message })).toEqual(expected);
      const [entry] = entries("", false);
      if (entry?.type !== "message") throw new Error("Expected assistant fixture");
      expect(projectSessionEntries([{ ...entry, message }, stopEntry(stop)])).toEqual(expected);
    },
  );

  it.each([
    { by: "unattributed" },
    { by: "session", sessionId: "private-id", title: "Unverified title", reason: "Private reason" },
  ])("shows only Stopped for an unverified stop ($by)", (stop) => {
    expect(projectSessionEntries([...entries("", false), stopEntry(stop)])).toEqual([
      { id: "entry-assistant-stopped", kind: "notice", tone: "info", title: "Stopped" },
    ]);
  });

  it("keeps a user-initiated stop neutral when reopening the persisted Pi branch", () => {
    const parts = projectSessionEntries([...entries("", false), stopEntry({ by: "user" })]);
    expect(parts).toEqual([
      expect.objectContaining({ kind: "notice", tone: "info", detail: "Stopped by you" }),
    ]);
    expect(parts.some((part) => part.kind === "notice" && part.tone === "error")).toBe(false);
    expect(settledSessionActivity("aborted", parts)).toBe("stopped");
    expect(settledSessionActivity(undefined, parts)).toBe("stopped");
  });

  it("keeps an unexpected interruption or provider error as a failure", () => {
    expect(projectSessionEntries(entries("Partial work", false))).toEqual([
      expect.objectContaining({ text: "Partial work", status: "error" }),
    ]);
    const failed = [...entries("", false), stopEntry({ by: "user" })];
    const entry = failed[0]!;
    if (entry.type === "message" && entry.message.role === "assistant") {
      entry.message.stopReason = "error";
      entry.message.errorMessage = "Provider unavailable";
    }
    expect(projectSessionEntries(failed)).toEqual([
      expect.objectContaining({ tone: "error", title: "Model request failed" }),
    ]);
  });
});
