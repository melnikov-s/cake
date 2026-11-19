import { expect, it } from "vitest";
import verification from "../../../docs/development/agent-verification.md?raw";
it("links debugging discipline to the shared checkpoint rule", () => {
  const debugging = verification.split("### Debugging discipline")[1];
  expect(debugging).toContain(
    "[checkpoint and reassessment rule](#failures-checkpoints-and-readiness)",
  );
  expect(verification).toMatch(/^#+ Failures, checkpoints and readiness$/im);
});
