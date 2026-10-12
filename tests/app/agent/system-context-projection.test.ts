import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  createCakeSessionRuntimeEventProjection,
  type RuntimeProjectionEvent,
} from "../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import {
  projectRuntimeSystemPrompt,
  projectSystemContext,
  withoutRuntimeSystemPrompt,
} from "../../../src/services/pi/runtime/system-context-projection";

const cakeSource = "<cake_system_prompt>\nCake desktop guidance\n</cake_system_prompt>";
const sections = {
  preamble: "Pi base instructions",
  rules: "<rules>\nPi rules\n</rules>",
  addendum: `<addendum>\nPersonal additions\n\n${cakeSource}\n\nSession additions\n</addendum>`,
  project_context: `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/home/AGENTS.md">\nPersonal rules\n</project_instructions>\n\n<project_instructions path="/project/AGENTS.md">\nProject rules\n</project_instructions>\n</project_context>`,
  skills: "<skills>\nAvailable skills\n</skills>",
  cwd: "<cwd>\n/project\n</cwd>",
  extension: "<extension>\nExtension instructions\n</extension>",
};
const prompt = Object.values(sections).join("\n\n");

describe("system instruction source projection", () => {
  it("discloses Pi, Cake, every instruction file, skills and additions separately in live and stored prompts", () => {
    const live = projectRuntimeSystemPrompt(prompt);
    const stored = projectSystemContext({ role: "system", sections }, "entry", "");
    expect(live.map(({ title, text }) => ({ title, text }))).toEqual(
      stored.map((part) => {
        if (part.kind !== "context") throw new Error("Expected context");
        return { title: part.title, text: part.text };
      }),
    );
    expect(live.map((part) => part.title)).toEqual([
      "Pi system prompt",
      "Additional instructions",
      "Cake system prompt",
      "Additional instructions",
      "AGENTS.md · /home/AGENTS.md",
      "AGENTS.md · /project/AGENTS.md",
      "Skills",
      "Working directory",
      "System section · extension",
    ]);
    expect(live.find((part) => part.title === "Pi system prompt")?.text).toBe(
      `${sections.preamble}\n\n${sections.rules}`,
    );
    expect(live.find((part) => part.title === "Cake system prompt")?.text).toBe(cakeSource);
    expect(live.find((part) => part.title === "AGENTS.md · /project/AGENTS.md")?.text).toBe(
      '<project_instructions path="/project/AGENTS.md">\nProject rules\n</project_instructions>',
    );
    expect(new Set(live.map((part) => part.id)).size).toBe(live.length);
  });

  it("deduplicates current sources without suppressing changed, removed, or compacted context", () => {
    const stored = projectSystemContext({ sections }, "entry", "");
    expect(withoutRuntimeSystemPrompt(stored, prompt)).toEqual([]);
    const patch = projectSystemContext({ sections: { addendum: sections.addendum } }, "patch", "");
    expect(withoutRuntimeSystemPrompt(patch, prompt)).toEqual(patch);
    const changed = projectSystemContext(
      { sections: { rules: "<rules>\nOld rules\n</rules>", obsolete: null } },
      "old",
      "",
    );
    const compacted = stored.map((part) => ({ ...part, origin: "compacted" as const }));
    expect(withoutRuntimeSystemPrompt([...changed, ...compacted], prompt)).toEqual([
      ...changed,
      ...compacted,
    ]);
  });

  it("does not infer Cake provenance from a user-written heading and preserves opaque and trailing instructions", () => {
    expect(projectRuntimeSystemPrompt("## Cake desktop environment\nCustom text")).toEqual([
      expect.objectContaining({
        title: "System prompt",
        text: "## Cake desktop environment\nCustom text",
      }),
    ]);
    expect(projectRuntimeSystemPrompt(`${prompt}\n\nForced extension note`)).toContainEqual(
      expect.objectContaining({ title: "System prompt", text: "Forced extension note" }),
    );
    expect(
      projectRuntimeSystemPrompt(
        "<project_context>\nUnstructured project instructions\n</project_context>",
      ),
    ).toContainEqual(
      expect.objectContaining({
        title: "Project context",
        text: "Unstructured project instructions",
      }),
    );
  });

  it("updates live source pills and removes ones no longer present on the next run", () => {
    const session = { systemPrompt: prompt };
    const events: RuntimeProjectionEvent[] = [];
    const projection = createCakeSessionRuntimeEventProjection({
      session: session as AgentSession,
      sessionId: "session",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      queuedParts: () => [],
      isDisposed: () => false,
    });
    projection.projectEvent({ type: "agent_start" });
    expect(events.filter((event) => event.type === "part-updated")).toHaveLength(9);
    events.length = 0;
    session.systemPrompt = "Isolated replacement instructions";
    projection.projectEvent({ type: "agent_start" });
    expect(
      events.filter((event) => event.type === "part-removed").map((event) => event.partId),
    ).toEqual(projectRuntimeSystemPrompt(prompt).map((part) => part.id));
    expect(events.filter((event) => event.type === "part-updated")).toEqual([
      expect.objectContaining({
        part: expect.objectContaining({ title: "System prompt", text: session.systemPrompt }),
      }),
    ]);
    projection.dispose();
  });
});
