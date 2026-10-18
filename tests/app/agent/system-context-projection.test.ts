import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
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

import {
  createLiveMessageProjector,
  projectSessionEntries,
} from "../../../src/services/pi/runtime/session-projection";
import { withoutTerminalDocumentation } from "../../../src/services/pi/runtime/pi-documentation";

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

  it.each([false, true])(
    "honors hidden recovery presentation without dropping visible messages (display=%s)",
    (display) => {
      const message = {
        role: "custom" as const,
        customType: "cake.restart-recovery",
        content: "Resume interrupted work",
        display,
        timestamp: 0,
      };
      const session = SessionManager.inMemory("/project");
      session.appendCustomMessageEntry(message.customType, message.content, message.display);
      const expected =
        display === false
          ? []
          : [
              expect.objectContaining({
                kind: "context",
                title: message.customType,
                text: message.content,
              }),
            ];
      expect(createLiveMessageProjector()({ type: "message_start", message })).toEqual(expected);
      expect(projectSessionEntries(session.getBranch())).toEqual(expected);
      // Display filtering never removes the model-facing Pi entry.
      expect(session.buildSessionContext().messages).toContainEqual(
        expect.objectContaining({
          customType: message.customType,
          content: message.content,
          display,
        }),
      );
    },
  );

  it("suppresses repeated sections and terminal-doc resets, but keeps real instruction and tool deltas live and on reopen", () => {
    const docs =
      "<docs>\nPi documentation: extensions, themes, skills, or TUI\nWhen asked about: extensions, themes (docs/themes.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md)\n</docs>";
    const initial = {
      role: "system" as const,
      content: "",
      sections: { ...sections, docs: withoutTerminalDocumentation(docs) },
      timestamp: 0,
    };
    const session = SessionManager.inMemory("/project");
    session.appendMessage(initial);
    const live = createLiveMessageProjector({ initialSystemMessages: [initial] });
    const reset = { ...initial, sections: { docs }, timestamp: 1 };
    session.appendMessage(reset);
    expect(live({ type: "message_start", message: reset })).toEqual([]);
    const baselineParts = projectSystemContext(initial, "baseline", "");
    const currentPrompt = `${prompt}\n\n${docs}`;
    expect(withoutRuntimeSystemPrompt(baselineParts, currentPrompt)).toEqual([]);
    expect(
      withoutRuntimeSystemPrompt(projectSessionEntries(session.getBranch()), currentPrompt),
    ).toEqual([]);

    const changed = {
      ...initial,
      sections: {
        rules: "<rules>\nNew policy\n</rules>",
        docs: `${docs}\nExtension documentation`,
        skills: null,
      },
      toolsAdded: [tools[0]!],
      toolsRemoved: [{ name: "write" }],
      timestamp: 2,
    };
    session.appendMessage(changed);
    const expected = [
      expect.objectContaining({
        kind: "context",
        title: "System",
        text: expect.stringContaining("New policy"),
      }),
      expect.objectContaining({
        kind: "context",
        title: "Tools",
        text: expect.stringContaining("Tools removed"),
      }),
      expect.objectContaining({
        kind: "context",
        title: "Skills",
        text: expect.stringContaining("Removed system prompt section"),
      }),
    ];
    const liveChanges = live({ type: "message_start", message: changed });
    expect(liveChanges).toEqual(expected);
    expect(liveChanges).toContainEqual(
      expect.objectContaining({
        title: "System",
        text: expect.stringContaining("Extension documentation"),
      }),
    );
    expect(projectSessionEntries(session.getBranch()).slice(baselineParts.length)).toEqual(
      expected,
    );
    const duplicate = { ...changed, toolsAdded: [], toolsRemoved: [], timestamp: 3 };
    session.appendMessage(duplicate);
    expect(live({ type: "message_start", message: duplicate })).toEqual([]);
    expect(projectSessionEntries(session.getBranch()).slice(baselineParts.length)).toEqual(
      expected,
    );
    const appended = {
      role: "system" as const,
      content: "An actual appended instruction",
      timestamp: 4,
    };
    expect(live({ type: "message_start", message: appended })).toEqual([
      expect.objectContaining({ title: "System", text: appended.content }),
    ]);
  });

  it("retains a docs-only change to actual guidance or installation paths", () => {
    const initial = {
      role: "system" as const,
      content: "",
      sections: { docs: "<docs>\nRead /old/docs for SDK guidance\n</docs>" },
      timestamp: 0,
    };
    const session = SessionManager.inMemory("/project");
    session.appendMessage(initial);
    const live = createLiveMessageProjector({ initialSystemMessages: [initial] });
    for (const docs of [
      "<docs>\nRead /new/docs for SDK guidance\n</docs>",
      "<docs>\nRead /new/docs before every SDK change\n</docs>",
    ]) {
      const message = { ...initial, sections: { docs } };
      session.appendMessage(message);
      const expected = [expect.objectContaining({ title: "System", text: docs })];
      expect(live({ type: "message_start", message })).toEqual(expected);
      expect(projectSessionEntries(session.getBranch()).slice(-1)).toEqual(expected);
    }
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

  it("shows only actual system messages, not synthetic fresh baselines, in forks", () => {
    const events: RuntimeProjectionEvent[] = [];
    const session = {
      systemPrompt: prompt,
      agent: { state: { tools } },
      sessionManager: { getHeader: () => ({ parentSession: "/source.jsonl" }) },
    } as unknown as AgentSession;
    const projection = createCakeSessionRuntimeEventProjection({
      session,
      sessionId: "fork",
      emit: (event) => events.push(event),
      compactionQueuedMessages: () => [],
      queuedParts: () => [],
      isDisposed: () => false,
    });
    try {
      projection.projectEvent({ type: "agent_start" });
      expect(events).toEqual([{ type: "streaming", sessionId: "fork", streaming: true }]);
      projection.projectEvent({
        type: "message_start",
        message: { role: "system", content: "", sections: { rules: sections.rules }, timestamp: 0 },
      });
      expect(events.filter((event) => event.type === "part-updated")).toEqual([
        expect.objectContaining({
          part: expect.objectContaining({ title: "System", text: sections.rules }),
        }),
      ]);
    } finally {
      projection.dispose();
    }
  });

  it("refreshes live groups and removes absent Skills/AGENTS.md when the next run replaces the prompt", () => {
    const session = {
      sessionManager: { getHeader: () => undefined },
      systemPrompt: prompt,
      agent: { state: { tools } },
    };
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
