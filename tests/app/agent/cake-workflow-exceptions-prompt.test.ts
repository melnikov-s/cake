import { expect, it } from "vitest";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import repo from "../../../AGENTS.md?raw";
it("honors task-scoped user overrides without weakening security", () => {
  expect(common).toContain("Current explicit user direction overrides Cake workflow defaults");
  expect(common).toContain(
    "including family/channel rules, not security boundaries or tool limits",
  );
  expect(repo).toContain("No instruction-file edit or repeated approval needed");
});
it("allows only requested check-ins, with durable cancellation and evidence", () => {
  expect(common).toContain("Poll/check in only if requested");
  for (const rule of [
    "sessions.schedule",
    "durable repeats",
    "one check-in per task",
    "cancel on completion/pause/stop",
    "successful result",
  ])
    expect(communication).toContain(rule);
});
