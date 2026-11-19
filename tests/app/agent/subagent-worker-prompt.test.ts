import { describe, expect, it } from "vitest";
import {
  projectInvestigationSystemPrompt,
  researchSystemPrompt,
} from "../../../src/services/pi/subagent-system-prompt";
import mutationPolicy from "../../../src/services/pi/runtime/prompts/worker-mutations.md?raw";
import investigationOnlyPolicy from "../../../src/services/pi/runtime/prompts/worker-investigation-only.md?raw";

describe.each([
  ["project", projectInvestigationSystemPrompt],
  ["research", researchSystemPrompt],
])("%s worker", (_, prompt) => {
  it.each([false, true])("renders only the selected mutation policy (mutations=%s)", (allow) => {
    const text = prompt({ allowMutations: allow });
    const [selected, other] = allow
      ? [mutationPolicy, investigationOnlyPolicy]
      : [investigationOnlyPolicy, mutationPolicy];
    expect(text).toContain(selected.trim());
    expect(text).not.toContain(other.trim());
    expect(text).not.toContain("{{");
  });
});
