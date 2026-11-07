import { expect, it } from "vitest";
import common from "../../../src/services/pi/runtime/prompts/common.md?raw";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import project from "../../../src/services/pi/runtime/prompts/project.md?raw";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
it("keeps bounded output and failure honesty in both roles", () => {
  for (const prompt of [
    coordinatorSystemPrompt("", "/docs"),
    renderPromptTemplate(project, { commonPrompt: common, cakeDocsDirectory: "/docs" }),
  ])
    expect(prompt).toContain("Keep tool output bounded; expose failures");
});
