import { describe, expect, it } from "vitest";
import {
  projectInvestigationSystemPrompt,
  researchSystemPrompt,
} from "../../../src/services/pi/subagent-system-prompt";

describe.each([
  ["project investigator", projectInvestigationSystemPrompt],
  ["general researcher", researchSystemPrompt],
])("Cake Chat %s prompt", (_, prompt) => {
  it("is investigation-only without allowMutations", () => {
    const text = prompt({ allowMutations: false });
    expect(text).toContain("Investigations only: do not write, edit, delete or otherwise mutate");
    expect(text).toContain("Refuse mutation requests even if your parent");
    expect(text).toContain("`allowMutations: true`");
    expect(text).not.toContain("Mutation mode:");
    expect(text).not.toContain("{{");
  });

  it("permits scoped, reported mutations with allowMutations", () => {
    const text = prompt({ allowMutations: true });
    expect(text).toContain("Mutation mode: your parent explicitly started you");
    expect(text).toContain("run scripts, stop or kill processes, install packages");
    expect(text).toContain("Stay within the stated assignment scope");
    expect(text).toContain("Report exactly what you changed");
    expect(text).toContain(
      "Do not mutate Git state on shared branches (no commits, pushes, merges, rebases, resets, branch deletions or force operations) unless the assignment explicitly instructs",
    );
    expect(text).not.toContain("Investigations only");
    expect(text).not.toContain("Refuse mutation requests");
    expect(text).not.toContain("{{");
  });
});

it("keeps the project investigator non-recursive in both modes", () => {
  for (const allowMutations of [false, true])
    expect(projectInvestigationSystemPrompt({ allowMutations })).toContain(
      "Do not create Project Sessions or delegate recursively.",
    );
});
