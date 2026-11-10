import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import models from "../../../docs/agent/models.md?raw";
import presentation from "../../../docs/agent/presentation.md?raw";
it("shows local and generated images inline without extra reads", () => {
  expect(coordinatorSystemPrompt("", "/docs")).toContain(
    "Show local images inline by absolute path",
  );
  expect(presentation).toContain("![description](/absolute/path), inline");
  expect(models).toContain("show native image blocks inline");
  expect(models).toContain("Save only when requested");
});
