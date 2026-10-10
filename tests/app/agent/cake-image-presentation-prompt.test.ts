import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import { renderPromptTemplate } from "../../../src/services/pi/runtime/prompt-template";
import commonTemplate from "../../../src/services/pi/runtime/prompts/common.md?raw";
import projectTemplate from "../../../src/services/pi/runtime/prompts/project.md?raw";
import interactionTemplate from "../../../src/services/pi/runtime/prompts/project-interaction.md?raw";
import interviewTemplate from "../../../src/services/pi/runtime/prompts/interview.md?raw";

const projectPrompt = renderPromptTemplate(projectTemplate, {
  commonPrompt: renderPromptTemplate(commonTemplate),
  projectInteractionPrompt: renderPromptTemplate(interactionTemplate, {
    interviewPrompt: renderPromptTemplate(interviewTemplate),
  }),
});

it.each([
  ["Project Session", projectPrompt],
  ["Cake Chat", coordinatorSystemPrompt("")],
])("%s instructs agents to display images inline rather than as clickable links", (_, prompt) => {
  expect(prompt).toContain("Always present images, screenshots, and visual previews inline");
  expect(prompt).toContain("never as plain clickable links");
  expect(prompt).toContain("![Description](working-directory-relative-image-path)");
  expect(prompt).toContain("native inline image output");
});

it("Project Session saved-image guidance also requires inline presentation", () => {
  expect(projectPrompt).toContain("display the saved image inline with Markdown image syntax");
});
