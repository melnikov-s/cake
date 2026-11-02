import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { projectSessionEntries } from "../../../src/services/pi/runtime/session-projection";
import { createNestedToolActivityProjection } from "../../../src/services/pi/runtime/nested-tool-activity-projection";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";

const assistant = {
  role: "assistant" as const,
  api: "openai-completions" as const,
  provider: "fixture",
  model: "fixture",
  content: [{ type: "toolCall" as const, id: "batch", name: "codemode", arguments: { code: "" } }],
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse" as const,
  timestamp: 0,
};

describe("nested artifact publication projection", () => {
  it("restores each publication from its pointer and Pi nested-call record, not codemode output text", () => {
    const manager = SessionManager.inMemory("/project");
    manager.appendMessage(assistant);
    const branchWithoutPublications = manager.getBranch();
    for (const index of [1, 2]) {
      // The second operation starts after the first pointer moved the Pi leaf.
      const leaf = manager.getLeafId()!;
      manager.appendCustomEntry("cake.artifact/v1", {
        protocol: "cake.artifact/v1",
        lineageId: `widget-${index}`,
        revision: 1,
        kind: "widget",
        digest: "a".repeat(64),
        stableRef: `cake://artifact/widget-${index}`,
        exactRef: `cake://artifact/widget-${index}@r1`,
        origin: { assistantEntryId: leaf, toolCallId: `batch/${index}` },
      });
    }
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "batch",
      toolName: "codemode",
      content: [{ type: "text", text: "Script completed; output omitted" }],
      isError: false,
      timestamp: 1,
      nestedCalls: {
        complete: true,
        calls: [1, 2].map((index) => ({
          id: `batch/${index}`,
          name: "cake",
          arguments: { command: "widgets.instantiate", input: { id: `widget-${index}` } },
          status: "ok" as const,
        })),
      },
    });
    const parts = projectSessionEntries(manager.getBranch());
    expect(parts.filter((part) => part.kind === "tool" && part.artifactId)).toEqual(
      [1, 2].map((index) =>
        expect.objectContaining({
          id: `tool-batch/${index}`,
          kind: "tool",
          artifactId: `widget-${index}`,
          artifactRevision: 1,
          state: "success",
        }),
      ),
    );
    expect(parts[0]).toMatchObject({ id: "tool-batch", name: "codemode" });
    expect(
      projectSessionEntries(branchWithoutPublications).filter(
        (part) => part.kind === "tool" && part.artifactId,
      ),
    ).toEqual([]);
  });

  it("shows a live nested publication as its own inline-capable part without losing the batch activity", () => {
    const parts: UiPart[] = [];
    const projection = createNestedToolActivityProjection((part) => parts.push(part));
    projection.project({
      id: "tool-batch",
      kind: "tool",
      name: "codemode",
      input: "",
      state: "running",
    });
    projection.project(
      {
        id: "tool-batch/1",
        kind: "tool",
        name: "cake",
        command: "widgets.instantiate",
        input: "",
        artifactId: "widget-1",
        artifactRevision: 1,
        state: "success",
      },
      "batch",
    );
    expect(parts).toContainEqual(
      expect.objectContaining({ id: "tool-batch/1", artifactId: "widget-1" }),
    );
    expect(parts.findLast((part) => part.id === "tool-batch")).toMatchObject({
      nestedCalls: { calls: [{ id: "tool-batch/1", state: "success" }] },
    });
  });
});
