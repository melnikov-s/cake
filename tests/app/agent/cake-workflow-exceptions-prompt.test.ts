import { describe, expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import communication from "../../../docs/agent/communication.md?raw";
import repoInstructions from "../../../AGENTS.md?raw";

const projectPrompt = renderPromptTemplate(projectTemplate, {
  commonPrompt: renderPromptTemplate(commonTemplate),
  cakeDocsDirectory: "/cake/docs",
});

describe.each([
  ["Project Session", projectPrompt],
  ["Cake Chat", coordinatorSystemPrompt("", "/cake/docs")],
])("%s user-directed workflow guidance", (_, prompt) => {
  it("keeps user override boundaries and opt-in polling in the shared core", () => {
    expect(prompt).toContain(
      "Current explicit user direction overrides earlier user-authored repo instructions",
    );
    expect(prompt).toContain("including harness-injected family/channel/process policies");
    expect(prompt).toContain("No AGENTS edit or repeated confirmation is needed");
    expect(prompt).toContain(
      "Genuine provider/platform/system constraints, security boundaries and tool capabilities still apply",
    );
    expect(prompt).toContain('not "harness forbids"');
    expect(prompt).toContain("Polling/check-ins require explicit user request");
    expect(prompt).toContain(
      "read `communication.md` before sending, selecting delivery or scheduling",
    );
  });
});

it("centralizes durable check-ins without losing cancellation or execution evidence", () => {
  for (const rule of [
    "including when completion events do not wake the coordinator",
    "Use durable scheduling when available at the requested interval",
    "`sessions.schedule` without `sessionId` targets your own conversation",
    "`repeatEverySeconds` creates one recurring entry",
    "Keep at most one pending check-in per coordinator task",
    "`sessions.scheduled`",
    "`sessions.cancel-scheduled` when finished or asked to pause/stop",
    "never busy-wait/sleep-loop",
    "without a confirming tool result",
    "including explicit user exceptions",
  ])
    expect(communication).toContain(rule);
  expect(workgroups).toContain("Read `communication.md` before user-requested periodic check-ins");
  expect(workgroups).toContain(
    "Current explicit user instructions override Cake-owned family/channel/process defaults",
  );
});

it("repository policy honors user direction without claiming platform authority", () => {
  expect(repoInstructions).toContain("including Cake policies injected by the harness");
  expect(repoInstructions).toContain("without an AGENTS.md edit or repeated confirmation");
  expect(repoInstructions).toContain(
    "This does not override genuine provider/platform/system constraints",
  );
  expect(repoInstructions).toContain("grant missing tools, or authorize unrelated actions");
});
