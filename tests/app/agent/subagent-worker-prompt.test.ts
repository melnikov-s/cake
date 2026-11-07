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
      "No shared-branch Git mutations unless that exact action is assigned",
      "Report changed files/settings/packages",
    ])
      expect(text).toContain(rule);
  });
});
it("keeps investigator non-recursive", () => {
  for (const allowMutations of [false, true])
    expect(projectInvestigationSystemPrompt({ allowMutations })).toContain(
      "Do not create Project Sessions or delegate recursively",
    );
});
