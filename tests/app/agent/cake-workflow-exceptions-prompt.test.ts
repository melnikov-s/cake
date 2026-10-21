import { describe, expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import chatGuide from "../../../docs/agent/cake-chat.md?raw";
import repoInstructions from "../../../AGENTS.md?raw";

const projectPrompt = renderPromptTemplate(projectTemplate, {
  commonPrompt: renderPromptTemplate(commonTemplate),
  cakeDocsDirectory: "/cake/docs",
});

describe.each([
  ["Project Session", projectPrompt, workgroups],
  ["Cake Chat", coordinatorSystemPrompt("", "/cake/docs"), chatGuide],
])("%s user-directed workflow guidance", (_, prompt, guide) => {
  it("keeps polling opt-in with durable scheduling and truthful runtime limits in the required guide", () => {
    expect(prompt).toContain(
      "Current explicit user direction overrides earlier user-authored repo instructions",
    );
    expect(prompt).toContain("including harness-injected family/channel/process policies");
    expect(guide).toContain(
      "Do not periodically poll or schedule coordination check-ins unless the user explicitly requests them",
    );
    expect(guide).toContain("including when completion events do not wake the coordinator");
    expect(guide).toContain("Use durable scheduling when available at the requested interval");
    expect(guide).toContain(
      "`sessions.schedule` with `sessionId` omitted targets your own conversation (Cake Chat, a Project Chat or a Project Session)",
    );
    expect(guide).toContain("`sessions.cancel-scheduled` stops one");
    expect(guide).toContain("keep at most one pending check-in for the coordinator task");
    expect(guide).toContain(
      "stop scheduling when the task finishes or the user asks to pause or stop",
    );
    expect(guide).toContain("do not busy-wait or sleep-loop");
    expect(guide).toContain("without a confirming tool result");
  });

  it("honors permitted user exceptions while preserving hard constraints and communication channels", () => {
    expect(guide).toContain(
      "Current explicit task-scoped user instructions override earlier user-authored repository instructions",
    );
    expect(guide).toContain("No AGENTS.md edit or repeated confirmation is needed");
    expect(guide).toContain(
      "including harness-injected Cake policies and family communication/channel/process defaults",
    );
    expect(guide).toContain(
      "Genuine provider/platform/system constraints, security boundaries and actual tool capabilities still apply",
    );
    expect(guide).toContain('not a blanket "harness forbids" refusal');
    expect(guide).toContain("Confirm execution with tool evidence");
  });
});

it("repository policy honors current user direction across Cake-injected defaults without claiming platform authority", () => {
  expect(repoInstructions).toContain("including Cake policies injected by the harness");
  expect(repoInstructions).toContain("without an AGENTS.md edit or repeated confirmation");
  expect(repoInstructions).toContain(
    "This does not override genuine provider/platform/system constraints",
  );
  expect(repoInstructions).toContain("grant missing tools, or authorize unrelated actions");
});

it("both role kernels permit the explicit polling exception without preloading the full guide", () => {
  expect(projectPrompt).toContain("Polling requires explicit user request");
  expect(coordinatorSystemPrompt("", "/cake/docs")).toContain(
    "Polling/check-ins are off by default; user requests permit them per cake-chat.md",
  );
});
