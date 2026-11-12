import { describe, expect, it } from "vitest";
import {
  projectInvestigationSystemPrompt,
  researchSystemPrompt,
} from "../../../src/services/pi/subagent-system-prompt";
describe.each([
  ["project", projectInvestigationSystemPrompt],
  ["research", researchSystemPrompt],
])("%s worker", (_, prompt) => {
  it("enforces investigation scope across tools", () => {
    const text = prompt({ allowMutations: false });
    for (const rule of [
      "Investigations only: no mutations through any tool",
      "Shell/MCP are not sandboxes",
      "new allowMutations: true worker",
    ])
      expect(text).toContain(rule);
  });
  it("allows only scoped and reported operational mutations", () => {
    const text = prompt({ allowMutations: true });
    for (const rule of [
      "Mutation mode: allowMutations: true",
      "only assigned operational changes",
      "Confirm targets",
      "No shared-branch Git mutations unless assigned",
      "Report changed files/settings/packages",
      "explicitly authorized non-project file/config edits",
      "Never edit Cake/Pi managed settings or credentials",
      "stopped processes (PID/command)",
    ])
      expect(text).toContain(rule);
  });
});
it("keeps project-free paths on the backend and clarifies ambiguous local targets", () => {
  for (const allowMutations of [false, true]) {
    expect(researchSystemPrompt({ allowMutations })).toContain(
      "Backend paths, not frontend files; clarify ambiguous local config",
    );
  }
});

it("keeps investigator non-recursive", () => {
  for (const allowMutations of [false, true])
    expect(projectInvestigationSystemPrompt({ allowMutations })).toContain(
      "Do not create Project Sessions or delegate recursively",
    );
});
