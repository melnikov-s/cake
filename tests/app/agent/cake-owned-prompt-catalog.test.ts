import { readFile, readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import { MEMORY_COMPACTOR_PROMPT } from "../../../src/services/pi-durable/durable-memory-policy";
import { defaultCakePrompts } from "../../../src/contracts/application/cake-prompt-defaults";

const promptDirectory = new URL("../../../src/services/pi/runtime/prompts/", import.meta.url);
// Ratchets at current byte sizes: growth requires a deliberate budget edit.
const budgets = {
  "cake-chat.md": 3994,
  "common.md": 930,
  "general-research.md": 565,
  "interview.md": 108,
  "project-interaction.md": 239,
  "project-investigation.md": 610,
  "project.md": 1575,
  "subagent.md": 288,
  "worker-investigation-only.md": 244,
  "worker-mutations.md": 446,
  "worktree-landing-merge.md": 259,
  "worktree-landing-pull-request.md": 169,
  "worktree.md": 264,
};

// Per-door ratchets at current byte sizes (reading cost at each door, not total knowledge).
const guideBudgets: Record<string, number> = {
  "application.md": 2134,
  "artifact-designs.md": 2559,
  "artifact-runtime.md": 3967,
  "artifacts.md": 3011,
  "auto-merge.md": 1595,
  "cake-chat.md": 2050,
  "chat-todos.md": 5128,
  "communication.md": 2195,
  "context-forks.md": 1546,
  "delegation.md": 4975,
  "delivery-details.md": 4827,
  "family-coordination.md": 1579,
  "family-delegation.md": 1469,
  "family-details.md": 3863,
  "family-lifecycle.md": 1657,
  "family-startup.md": 848,
  "history-memory.md": 2989,
  "index.md": 2294,
  "interactions.md": 1626,
  "model-generation.md": 2894,
  "models.md": 2474,
  "nonproject-execution.md": 1727,
  "presentation.md": 2057,
  "reports.md": 4493,
  "session-compaction.md": 2633,
  "session-discovery-details.md": 2988,
  "session-discovery.md": 2242,
  "session-history.md": 1806,
  "session-prompt-files.md": 1455,
  "sessions.md": 4299,
  "settings-themes.md": 1557,
  "settings-voice.md": 3479,
  "settings.md": 2676,
  "todo-details.md": 7659,
  "todo-pane.md": 1175,
  "widget-attachments.md": 2408,
  "widget-authoring.md": 4221,
  "widget-sdk.md": 4298,
  "widget-theme.md": 2083,
  "workgroups.md": 1375,
};

describe("Cake-owned prompt catalog", () => {
  it("keeps every shipped role template bounded and renderable", async () => {
    expect((await readdir(promptDirectory)).sort()).toEqual(Object.keys(budgets).sort());
    for (const [name, budget] of Object.entries(budgets)) {
      const template = await readFile(new URL(name, promptDirectory), "utf8");
      expect(Buffer.byteLength(template), name).toBeLessThanOrEqual(budget);
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

  it("bounds the reading cost of each task guide door", async () => {
    const directory = new URL("../../../docs/agent/", import.meta.url);
    const names = (await readdir(directory)).filter((name) => name.endsWith(".md"));
    expect(names.sort()).toEqual(Object.keys(guideBudgets).sort());
    for (const name of names) {
      const content = await readFile(new URL(name, directory), "utf8");
      expect(Buffer.byteLength(content), name).toBeLessThanOrEqual(guideBudgets[name]!);
    }
  });

  it("preserves the built-in prototype module files and saved-selection payload", async () => {
    const directory = new URL("../../../src/services/pi/skills/prototype-ui/", import.meta.url);
    const widget = await readFile(new URL("widget.md", directory), "utf8");
    const skill = await readFile(new URL("SKILL.md", directory), "utf8");
    const payloads = [...widget.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
      JSON.parse(match[1]!),
    );
    expect(payloads).toEqual([{ schema: "cake.prototype-ui/v1", selectedOptionId: null }]);
    const approach = skill.slice(
      skill.indexOf("## Choose the rendering approach"),
      skill.indexOf("## Optional interactive saved-choice/source-handoff workflow"),
    );
    expect(Buffer.byteLength(approach)).toBeLessThan(5_000);
    expect(Buffer.byteLength(skill.replace(approach, ""))).toBeLessThan(6_900);
    expect(Buffer.byteLength(widget)).toBeLessThan(6_100);
  });

  it("bounds the compaction prompt", () => {
    // Ratchet at the current size: growth requires a deliberate budget edit.
    expect(Buffer.byteLength(MEMORY_COMPACTOR_PROMPT)).toBeLessThanOrEqual(799);
  });

  it("keeps exact landing commands and operations in stock conflict prompts", () => {
    const defaults = defaultCakePrompts();
    expect(defaults.worktreeRebaseConflict).toContain("GIT_EDITOR=true git rebase --continue");
    expect(defaults.worktreePreserveConflict).toContain("GIT_EDITOR=true git rebase --continue");
    expect(defaults.worktreeSquashConflict).toContain("git commit --no-edit");
    expect(defaults.worktreeSquashMessage).toContain("worktrees.proposeSquashMessage");
  });
});
