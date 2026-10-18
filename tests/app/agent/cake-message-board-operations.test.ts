import { describe, expect, it, vi } from "vitest";
import { createMessageBoardOperations } from "../../../src/domain/artifacts/cake-message-board-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import type { MessageBoardControl } from "../../../src/contracts/artifacts/message-board-control";

const context = { signal: new AbortController().signal, toolCallId: "board", runtime: {} };
const description = {
  sequence: 2,
  authorSessionId: "12345678",
  createdAt: "2026-01-01T00:00:00Z",
  audience: "workgroup" as const,
  topic: "output",
  supersedes: [1],
  description: "Use file-backed output",
};
const fixture = () => {
  const current = vi.fn(async () => ({
    boardId: "board",
    entries: [description],
    nextAfter: 2,
    hasMore: false,
  }));
  const append = vi.fn(async () => ({ boardId: "board", entry: description }));
  const recordIntake = vi.fn(async () => {});
  const read = vi.fn(async () => ({
    boardId: "board",
    entries: [{ ...description, body: "Detailed evidence" }],
  }));
  const control: MessageBoardControl = {
    current,
    append,
    read,
    recordIntake,
    readNew: current,
    entryReceipts: async () => ({ entry: description, receipts: [] }),
    sessionReceipts: async (sessionId) => ({
      boardId: "board",
      sessionId,
      entries: [],
      nextAfter: 0,
      hasMore: false,
    }),
  };
  return {
    registry: new CakeOperationRegistry(createMessageBoardOperations(control)),
    current,
    append,
    read,
    recordIntake,
  };
};

describe("Workboard agent protocol", () => {
  it("discloses boards and the current-decisions query with explicit targeting guidance", () => {
    const { registry } = fixture();
    expect(registry.help()).toContain("boards —");
    expect(registry.topicHelp("boards")).toContain("boards.current");
    const appendHelp = registry.operationHelp("boards.append");
    expect(appendHelp).toContain("Audience is required");
    expect(appendHelp).toContain(
      "assignments and their substantive results belong exclusively on this board",
    );
    expect(appendHelp).toContain("not in sessions.send/reply or private side channels");
    expect(appendHelp).toContain("resultDelivery: ignore");
    expect(appendHelp).toContain(
      "do not wake idle members or clear existing runtime-managed report obligations",
    );
  });
  it("returns bounded typed current descriptions and relations without fetching bodies or recording reads", async () => {
    const { registry, current, read, recordIntake } = fixture();
    const result = await registry.invoke(
      { command: "boards.current", input: { topic: "output", limit: 1, after: 0 } },
      context,
    );
    expect(current).toHaveBeenCalledWith({ topic: "output", limit: 1, after: 0 });
    expect(result.structuredContent).toEqual({
      command: "boards.current",
      result: { boardId: "board", entries: [description], nextAfter: 2, hasMore: false },
    });
    expect(read).not.toHaveBeenCalled();
    expect(recordIntake).not.toHaveBeenCalled();
  });
  it.each([
    { description: "Decision", body: "Evidence" },
    { description: "Decision", body: "Evidence", audience: [] },
    { description: "Decision", body: "Evidence", audience: "workgroup", topic: "Not a topic" },
    { description: "Decision", body: "Evidence", audience: "workgroup", supersedes: [0] },
  ])("rejects invalid append arguments before posting: %j", async (input) => {
    const { registry, append } = fixture();
    await expect(registry.invoke({ command: "boards.append", input }, context)).rejects.toThrow();
    expect(append).not.toHaveBeenCalled();
  });
  it("passes explicit owner references and correction links through the validated operation", async () => {
    const { registry, append } = fixture();
    const input = {
      description: "Decision",
      body: "Evidence",
      audience: ["12345678"],
      topic: "output",
      supersedes: [1],
    };
    await registry.invoke({ command: "boards.append", input }, context);
    expect(append).toHaveBeenCalledWith(input);
  });
});
