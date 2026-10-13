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

const tools = [
  {
    name: "read",
    description: "Read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
  { name: "cake", description: "Cake controls", parameters: { type: "object" } },
];
const cakeSource = "<cake_system_prompt>\nCake desktop guidance\n</cake_system_prompt>";
const sections = {
  preamble: "Pi base instructions",
  tools: "<tools>\nAvailable tools\n</tools>",
  rules: "<rules>\nPi rules\n</rules>",
  addendum: `<addendum>\nPersonal additions\n\n${cakeSource}\n\nSession additions\n</addendum>`,
  project_context: `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/home/AGENTS.md">\nPersonal rules\n</project_instructions>\n\n<project_instructions path="/project/AGENTS.md">\nProject rules\n</project_instructions>\n</project_context>`,
  skills: "<skills>\nAvailable skills\n</skills>",
  cwd: "<cwd>\n/project\n</cwd>",
  extension: "<extension>\nExtension instructions\n</extension>",
};
const prompt = Object.values(sections).join("\n\n");

function context() {
  return projectSystemContext({ role: "system", sections, toolsAdded: tools }, "entry", "");
}

describe("system instruction source projection", () => {
  it("groups live and stored baselines into System, Tools, Skills and AGENTS.md without losing sources", () => {
    const live = projectRuntimeSystemPrompt(prompt, "runtime", tools);
    const stored = context();
    expect(live.map(({ title, text }) => ({ title, text }))).toEqual(
      stored.map((part) => {
        if (part.kind !== "context") throw new Error("Expected context");
        return { title: part.title, text: part.text };
      }),
    );
    expect(live.map((part) => part.title)).toEqual(["System", "Tools", "Skills", "AGENTS.md"]);
    const system = live.find((part) => part.title === "System")!.text;
    for (const text of [
      sections.preamble,
      sections.rules,
      cakeSource,
      "Personal additions",
      "Session additions",
      sections.cwd,
      sections.extension,
    ])
      expect(system).toContain(text);
    const instructions = live.find((part) => part.title === "AGENTS.md")!.text;
    expect(instructions).toContain("/home/AGENTS.md");
    expect(instructions).toContain("Personal rules");
    expect(instructions).toContain("/project/AGENTS.md");
    expect(instructions).toContain("Project rules");
    const declared = live.find((part) => part.title === "Tools")!.text;
    expect(declared).toContain(sections.tools);
    expect(declared).toContain(JSON.stringify(tools, null, 2));
    expect(new Set(live.map((part) => part.id)).size).toBe(live.length);
  });

  it("shows Worktree only for explicit worktree sources, including managed setup instructions", () => {
    const worktree = "<worktree_instructions>\nWorktree isolation\n</worktree_instructions>";
    const setup =
      "<worktree_instructions>\n## Project worktree setup instructions\n\nUse the dependency symlink\n</worktree_instructions>";
    const live = projectRuntimeSystemPrompt(
      `${prompt}\n\n${worktree}\n\n<addendum>\n${cakeSource}\n${setup}\n</addendum>`,
      "runtime",
      tools,
    );
    expect(live.map((part) => part.title)).toEqual([
      "System",
      "Tools",
      "Skills",
      "Worktree",
      "AGENTS.md",
    ]);
    expect(live.find((part) => part.title === "Worktree")!.text).toContain(worktree);
    expect(live.find((part) => part.title === "Worktree")!.text).toContain(setup);
    expect(
      projectRuntimeSystemPrompt("## Worktree instructions\nUser-authored heading").map(
        (part) => part.title,
      ),
    ).toEqual(["System"]);
  });

  it("deduplicates complete baselines but retains partial, removed and changed context", () => {
    const stored = context();
    expect(withoutRuntimeSystemPrompt(stored, prompt, tools)).toEqual([]);
    const patch = projectSystemContext({ sections: { addendum: sections.addendum } }, "patch", "");
    expect(withoutRuntimeSystemPrompt(patch, prompt, tools)).toEqual(patch);
    const changed = projectSystemContext(
      { sections: { rules: "<rules>\nOld rules\n</rules>", obsolete: null, skills: null } },
      "old",
      "",
    );
    expect(changed.map((part) => part.kind === "context" && part.title)).toEqual([
      "System",
      "Skills",
    ]);
    expect(withoutRuntimeSystemPrompt(changed, prompt, tools)).toEqual(changed);
    const changedTools = projectSystemContext(
      { sections, toolsAdded: [tools[0]] },
      "old-tools",
      "",
    );
    expect(withoutRuntimeSystemPrompt(changedTools, prompt, tools)).toEqual([
      expect.objectContaining({ title: "Tools", text: expect.stringContaining('"name": "read"') }),
    ]);
  });

  it("keeps opaque, unstructured and trailing instructions in System", () => {
    expect(projectRuntimeSystemPrompt("## Cake desktop environment\nCustom text")).toEqual([
      expect.objectContaining({
        title: "System",
        text: "## Cake desktop environment\nCustom text",
      }),
    ]);
    expect(projectRuntimeSystemPrompt(`${prompt}\n\nForced extension note`)).toContainEqual(
      expect.objectContaining({
        title: "System",
        text: expect.stringContaining("Forced extension note"),
      }),
    );
    expect(
      projectRuntimeSystemPrompt(
        "<project_context>\nUnstructured project instructions\n</project_context>",
      ),
    ).toEqual([
      expect.objectContaining({ title: "System", text: "Unstructured project instructions" }),
    ]);
  });

  it("groups tool additions and removals into Tools and keeps their complete schemas", () => {
    const parts = projectSystemContext(
      { toolsAdded: tools, toolsRemoved: [{ name: "write" }] },
      "patch",
      "",
    );
    expect(parts).toEqual([
      expect.objectContaining({ title: "Tools", text: expect.stringContaining("Tools removed") }),
    ]);
    const part = parts[0];
    if (part?.kind !== "context") throw new Error("Expected Tools");
    expect(part.text).toContain(JSON.stringify(tools, null, 2));
    expect(part.text).toContain('"name": "write"');
  });

  it("refreshes live groups and removes absent Skills/AGENTS.md when the next run replaces the prompt", () => {
    const session = { systemPrompt: prompt, agent: { state: { tools } } };
    const events: RuntimeProjectionEvent[] = [];
    const projection = createCakeSessionRuntimeEventProjection({
      session: session as unknown as AgentSession,
      sessionId: "session",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      queuedParts: () => [],
      isDisposed: () => false,
    });
    projection.projectEvent({ type: "agent_start" });
    expect(events.filter((event) => event.type === "part-updated")).toHaveLength(4);
    events.length = 0;
    session.systemPrompt = "Isolated replacement instructions";
    session.agent.state.tools = [];
    projection.projectEvent({ type: "agent_start" });
    expect(
      events.filter((event) => event.type === "part-removed").map((event) => event.partId),
    ).toEqual([
      "runtime-system-prompt-tools",
      "runtime-system-prompt-skills",
      "runtime-system-prompt-instructions",
    ]);
    expect(events.filter((event) => event.type === "part-updated")).toEqual([
      expect.objectContaining({
        part: expect.objectContaining({ title: "System", text: session.systemPrompt }),
      }),
    ]);
    projection.dispose();
  });
});
