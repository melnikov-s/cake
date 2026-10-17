import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { contextSources } from "../../../../src/services/pi/runtime/context-outline";
import {
  projectContextInspection,
  projectMemoryDetail,
} from "../../../../src/services/pi/runtime/project-context-inspection";

describe("context outline", () => {
  it("separates contributing instruction files using their included text and preserves tool guidance", () => {
    const sources = contextSources(
      `System instructions\n<project_context>\nProject-specific instructions and guidelines:\n<project_instructions path="/work/AGENTS.md">\nIncluded root instructions\n</project_instructions>\n<project_instructions path="/work/src/AGENTS.md">\nIncluded renderer instructions\n</project_instructions>\n</project_context>\n<tools>\nUse tools carefully\n</tools>`,
      [{ name: "read" }],
      "/work",
    );
    expect(sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "System prompt", text: "System instructions" }),
        expect.objectContaining({
          title: "AGENTS.md",
          source: "/work/AGENTS.md",
          text: "Included root instructions",
        }),
        expect.objectContaining({
          title: "src/AGENTS.md",
          source: "/work/src/AGENTS.md",
          text: "Included renderer instructions",
        }),
      ]),
    );
    expect(sources.filter((source) => source.title === "Tools")).toHaveLength(1);
    expect(sources.find((source) => source.title === "Tools")?.text).toContain(
      "Use tools carefully",
    );
    expect(sources.find((source) => source.title === "Tools")?.text).toContain('"name": "read"');
  });

  it("separates current compaction memory from kept messages and reads only its earlier originals", () => {
    const manager = SessionManager.inMemory("/work");
    const old = manager.appendMessage({ role: "user", content: "Original decision", timestamp: 1 });
    const kept = manager.appendMessage({ role: "user", content: "Still in context", timestamp: 2 });
    const summary = manager.appendCompaction("A compressed decision", kept, 500);
    const before = manager.buildSessionContext();
    const context = projectContextInspection(
      { sessionManager: manager, messages: before.messages, systemPrompt: "System instructions" },
      "/work",
      [],
    );
    expect(context.sources.find((source) => source.id === "messages")?.children).toEqual([
      expect.objectContaining({ title: "You", text: "Still in context" }),
    ]);
    expect(context.sources.find((source) => source.id === "memory")?.children).toEqual([
      expect.objectContaining({ title: "A compressed decision", detail: { entryId: summary } }),
    ]);
    expect(projectMemoryDetail(manager, summary).sources).toEqual([
      expect.objectContaining({ text: "Original decision", source: old }),
    ]);
    expect(manager.buildSessionContext()).toEqual(before);
  });

  it("retains nested compaction provenance and pages large source ranges without clipping originals", () => {
    const manager = SessionManager.inMemory("/work");
    for (let index = 0; index < 105; index++)
      manager.appendMessage({ role: "user", content: `Original ${index}`, timestamp: index });
    const kept = manager.appendMessage({ role: "user", content: "Retained", timestamp: 106 });
    const first = manager.appendCompaction("First summary", kept, 1000);
    const newest = manager.appendMessage({
      role: "user",
      content: "Newest retained",
      timestamp: 107,
    });
    const second = manager.appendCompaction("Second summary", newest, 1000);
    const page = projectMemoryDetail(manager, first);
    expect(page.sources).toHaveLength(101);
    expect(page.sources.at(-1)).toMatchObject({
      title: "More messages",
      detail: { entryId: first, offset: 100 },
    });
    expect(projectMemoryDetail(manager, first, 100).sources).toHaveLength(5);
    expect(projectMemoryDetail(manager, second).sources).toEqual([
      expect.objectContaining({ title: "First summary", detail: { entryId: first } }),
      expect.objectContaining({ text: "Retained" }),
    ]);
    expect(() => projectMemoryDetail(manager, "missing")).toThrow("available source summary");
  });

  it("follows only the departed branch when inspecting a branch summary", () => {
    const manager = SessionManager.inMemory("/work");
    const shared = manager.appendMessage({ role: "user", content: "Shared start", timestamp: 1 });
    const departed = manager.appendMessage({
      role: "user",
      content: "Departed branch",
      timestamp: 2,
    });
    const summary = manager.branchWithSummary(shared, "Work on the departed branch");
    expect(projectMemoryDetail(manager, summary).sources).toEqual([
      expect.objectContaining({ text: "Departed branch", source: departed }),
    ]);
  });
});
