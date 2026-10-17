import { describe, expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import workgroups from "../../../docs/agent/workgroups.md?raw";
import chatGuide from "../../../docs/agent/cake-chat.md?raw";

const projectPrompt = renderPromptTemplate(projectTemplate, {
  commonPrompt: renderPromptTemplate(commonTemplate),
  cakeDocsDirectory: "/cake/docs",
});

describe.each([
  ["Project Session", projectPrompt, workgroups],
  ["Cake Chat", coordinatorSystemPrompt("", "/cake/docs"), chatGuide],
])("%s user-directed workflow guidance", (_, prompt, guide) => {
  it("keeps polling opt-in with durable scheduling and truthful runtime limits in the required guide", () => {
    expect(prompt).toContain("Cake workflow defaults permit explicit task-scoped user exceptions");
    expect(guide).toContain(
      "Do not periodically poll or schedule coordination check-ins unless the user explicitly requests them",
    );
    expect(guide).toContain("including when completion events do not wake the coordinator");
    expect(guide).toContain("Use durable scheduling when available at the requested interval");
    expect(guide).toContain("keep at most one pending check-in for the coordinator task");
    expect(guide).toContain(
      "stop scheduling when the task finishes or the user asks to pause or stop",
    );
    expect(guide).toContain("do not busy-wait or sleep-loop");
    expect(guide).toContain("without a confirming tool result");
  });

  it("honors permitted user exceptions while preserving hard constraints and communication channels", () => {
    expect(guide).toContain("follow the user's task-scoped exception");
    expect(guide).toContain("without requiring repeated confirmation or an AGENTS.md edit");
    expect(guide).toContain(
      "does not override provider/system requirements, tool authorization, security boundaries, or required family communication channels",
    );
    expect(guide).toContain(
      "Keep family assignments and results on their required communication channel",
    );
    expect(guide).toContain(
      "identify that specific constraint and the closest available alternative",
    );
  });
});

it("both role kernels permit the explicit polling exception without preloading the full guide", () => {
  expect(projectPrompt).toContain("Polling requires explicit user request");
  expect(coordinatorSystemPrompt("", "/cake/docs")).toContain(
    "Polling/check-ins are off by default; user requests permit them per cake-chat.md",
  );
});
