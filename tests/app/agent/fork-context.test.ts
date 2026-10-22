import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { retainRelocatedForkContext } from "../../../src/services/pi/runtime/fork-context";
import { projectSystemContext } from "../../../src/services/pi/runtime/system-context-projection";

const shared =
  "<cake_system_prompt>\nShared Cake guidance\n</cake_system_prompt>\n\n<session_instructions>\nSession guidance\n</session_instructions>";
const worktree = "<worktree_instructions>\nUse the destination checkout\n</worktree_instructions>";
const wrap = (name: string, value: string) => `<${name}>\n${value}\n</${name}>`;

function sources(cwd: string, addendum = shared) {
  return {
    cwd: wrap("cwd", cwd),
    project_context: wrap(
      "project_context",
      `<project_instructions path="${cwd}/AGENTS.md">\nRepository rules\n</project_instructions>`,
    ),
    skills: wrap(
      "skills",
      `<skill>\n<name>fixture</name>\n<location>${cwd}/.agents/skills/fixture/SKILL.md</location>\n</skill>`,
    ),
    addendum: wrap("addendum", addendum),
  };
}

function inherited(sections = sources("/source")): SystemMessage {
  return { role: "system", content: "", sections, timestamp: 0 };
}

function event(
  cwd = "/destination",
  sections = sources(cwd, `${shared}\n\n${worktree}`),
): BeforeAgentStartEvent {
  return {
    type: "before_agent_start",
    messageType: "user",
    prompt: "Continue",
    images: undefined,
    systemPrompt: Object.values(sections).join("\n\n"),
    systemPromptOptions: {
      cwd,
      sections: {},
      selectedTools: [],
      hiddenTools: [],
      toolSnippets: {},
      toolGuidelines: {},
      promptGuidelines: [],
      contextFiles: [],
      skills: [],
      appendSystemPrompt: "",
    },
  };
}

function replay(run: BeforeAgentStartEvent, base: SystemMessage): SystemMessage {
  return {
    ...base,
    sections: {
      ...base.sections,
      cwd: wrap("cwd", run.systemPromptOptions.cwd),
      ...Object.fromEntries(
        Object.entries(run.systemPromptOptions.sections).map(([name, value]) => [
          name,
          wrap(name, value),
        ]),
      ),
    },
  };
}

describe("relocated fork context", () => {
  it("retains unchanged sources and discloses only path/worktree changes", () => {
    const base = inherited();
    const run = event();
    retainRelocatedForkContext(run, base);
    const next = replay(run, base);
    for (const name of ["project_context", "skills", "addendum"])
      expect(next.sections?.[name]).toBe(base.sections?.[name]);
    const delta = Object.fromEntries(
      Object.entries(next.sections!).filter(([name, value]) => value !== base.sections?.[name]),
    );
    expect(Object.keys(delta)).toEqual(["cwd", "fork_paths", "fork_worktree"]);
    const pills = projectSystemContext(
      { sections: { fork_paths: delta.fork_paths, fork_worktree: delta.fork_worktree } },
      "fork",
      "",
    );
    expect(pills).toEqual([expect.objectContaining({ title: "Worktree" })]);
    expect(JSON.stringify(delta)).not.toContain("Repository rules");
    expect(JSON.stringify(delta)).not.toContain("Shared Cake guidance");
  });

  it("retains shared built-in skill paths while relocating project skills", () => {
    const builtin =
      "<skill>\n<name>cake:prototype-ui</name>\n<location>/source/agent/cake-skills/revision/prototype-ui/SKILL.md</location>\n</skill>";
    const base = sources("/source");
    base.skills = base.skills.replace("</skills>", `${builtin}\n</skills>`);
    const current = sources("/destination");
    current.skills = current.skills.replace("</skills>", `${builtin}\n</skills>`);
    const run = event("/destination", current);
    retainRelocatedForkContext(run, inherited(base));
    expect(wrap("skills", run.systemPromptOptions.sections.skills!)).toBe(base.skills);
  });

  it("keeps the same baseline on subsequent turns and reopen", () => {
    const first = event();
    const base = inherited();
    retainRelocatedForkContext(first, base);
    const stored = replay(first, base);
    const reopened = event();
    retainRelocatedForkContext(reopened, stored);
    expect(replay(reopened, stored)).toEqual(stored);
  });

  it("retains multiple inherited path origins when forking again", () => {
    const first = event();
    const base = inherited();
    retainRelocatedForkContext(first, base);
    const stored = replay(first, base);
    const second = event("/another");
    retainRelocatedForkContext(second, stored);
    expect(second.systemPromptOptions.sections.project_context).toBe(
      first.systemPromptOptions.sections.project_context,
    );
    expect(second.systemPromptOptions.sections.fork_paths).toContain("/source");
    expect(second.systemPromptOptions.sections.fork_paths).toContain("/destination");
    expect(second.systemPromptOptions.sections.fork_paths).toContain("/another");
  });

  it("does not suppress real instruction, skill, or Cake guidance changes", () => {
    const changed = sources("/destination", "Changed Cake guidance");
    changed.project_context = changed.project_context.replace(
      "Repository rules",
      "Changed repository rules",
    );
    changed.skills = changed.skills.replace("fixture</name>", "another</name>");
    const run = event("/destination", changed);
    retainRelocatedForkContext(run, inherited());
    expect(run.systemPromptOptions.sections.project_context).toBeUndefined();
    expect(run.systemPromptOptions.sections.skills).toBeUndefined();
    expect(run.systemPromptOptions.sections.addendum).toBeUndefined();
  });

  it("replaces inherited worktree guidance without repeating Cake guidance", () => {
    const run = event();
    retainRelocatedForkContext(
      run,
      inherited(
        sources(
          "/source",
          `${shared}\n\n<worktree_instructions>\nOld checkout\n</worktree_instructions>`,
        ),
      ),
    );
    expect(run.systemPromptOptions.sections.fork_worktree).toContain(
      "replaces all inherited worktree instructions",
    );
    expect(run.systemPromptOptions.sections.fork_worktree).toContain(worktree);
    expect(run.systemPromptOptions.sections.fork_worktree).not.toContain("Shared Cake guidance");
  });

  it("does not treat paths in instruction prose as relocated source metadata", () => {
    const base = sources("/source");
    base.project_context = base.project_context.replace("Repository rules", "Use /source/output");
    const current = sources("/destination");
    current.project_context = current.project_context.replace(
      "Repository rules",
      "Use /destination/output",
    );
    const run = event("/destination", current);
    retainRelocatedForkContext(run, inherited(base));
    expect(run.systemPromptOptions.sections.project_context).toBeUndefined();
  });

  it("leaves same-checkout forks and unstructured prompts alone", () => {
    const run = event("/source", sources("/source"));
    retainRelocatedForkContext(run, inherited());
    expect(run.systemPromptOptions.sections).toEqual({});
    retainRelocatedForkContext(run, {
      role: "system",
      content: "Opaque instructions",
      timestamp: 0,
    });
    expect(run.systemPromptOptions.sections).toEqual({});
  });
});
