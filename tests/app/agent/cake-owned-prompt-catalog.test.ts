import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { defaultCakePrompts } from "../../../src/contracts/application/cake-prompt-defaults";

const promptDirectory = new URL("../../../src/services/pi/runtime/prompts/", import.meta.url);
const roleTemplates = [
  "cake-chat.md",
  "common.md",
  "general-research.md",
  "interview.md",
  "project-interaction.md",
  "project-investigation.md",
  "project.md",
  "subagent.md",
  "worker-investigation-only.md",
  "worker-mutations.md",
  "worktree-landing-merge.md",
  "worktree-landing-pull-request.md",
  "worktree.md",
];

describe("Cake-owned prompt catalog", () => {
  it("keeps every shipped role template renderable", async () => {
    expect((await readdir(promptDirectory)).sort()).toEqual([...roleTemplates].sort());
    for (const name of roleTemplates) {
      const template = await readFile(new URL(name, promptDirectory), "utf8");
      const keys = [...template.matchAll(/{{\s*([A-Za-z][A-Za-z0-9]*)\s*}}/g)].map(
        (match) => match[1]!,
      );
      const rendered = renderPromptTemplate(
        template,
        Object.fromEntries(keys.map((key) => [key, `fixture-${key}`])),
      );
      expect(rendered, name).not.toContain("{{");
    }
  });

  it("keeps the prototype skill's widget guide and its saved-selection payload", async () => {
    const directory = new URL("../../../src/services/pi/skills/prototype-ui/", import.meta.url);
    const widget = await readFile(new URL("widget.md", directory), "utf8");
    const skill = await readFile(new URL("SKILL.md", directory), "utf8");
    const payloads = [...widget.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(payloads).toEqual([{ schema: "cake.prototype-ui/v1", selectedOptionId: null }]);
    expect(skill).toContain("`widget.md`");
  });

  it("keeps exact landing commands and operations in stock conflict prompts", () => {
    const defaults = defaultCakePrompts();
    expect(defaults.worktreeRebaseConflict).toContain("GIT_EDITOR=true git rebase --continue");
    expect(defaults.worktreePreserveConflict).toContain("GIT_EDITOR=true git rebase --continue");
    expect(defaults.worktreeSquashConflict).toContain("git commit --no-edit");
    expect(defaults.worktreeSquashMessage).toContain("worktrees.proposeSquashMessage");
  });
});
