import { describe, expect, it } from "vitest";
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

describe.each([
  ["Project Session", projectPrompt],
  ["Cake Chat", coordinatorSystemPrompt("")],
])("%s artifact guidance", (_, prompt) => {
  it("defaults lasting task documents to artifacts without a user reminder", () => {
    expect(prompt).toContain("Use Cake artifacts by default for lasting documents");
    expect(prompt).toContain("specs, plans, proposed contracts, audits, investigations, handoffs");
    expect(prompt).toContain("without waiting for the user to request an artifact");
    expect(prompt).toContain("Do not create repository Markdown files or duplicate artifacts");
  });

  it("shares readable revisions across sessions rather than assuming shared files or context", () => {
    expect(prompt).toContain("Share artifact references with other sessions");
    expect(prompt).toContain("recipients must discover or link the artifact and read");
    expect(prompt).toContain("Revise the same artifact");
    expect(prompt).toContain("use an exact revision for an approved spec or assignment baseline");
    expect(prompt).toContain("If your tools cannot publish artifacts");
    expect(prompt).toContain("have the owning Project Session publish the document");
  });

  it("preserves ordinary chat, maintained project docs, and requested files", () => {
    expect(prompt).toContain("Keep short answers and routine progress in chat");
    expect(prompt).toContain("maintained project documentation, executable code/tests");
    expect(prompt).toContain("an explicitly requested file deliverable");
  });
});

it("Project Sessions publish Markdown directly and include artifact references in child assignments", () => {
  expect(projectPrompt).toContain("publish Markdown directly with `artifacts.create`");
  expect(projectPrompt).toContain("revise it with `artifacts.update`");
  expect(projectPrompt).toContain(
    "artifact reference and relevant revision in child-session assignments",
  );
  expect(projectPrompt).toContain("ask recipients to read it before implementing the spec");
  expect(projectPrompt).toContain("For explicitly requested file-format deliverables");
});
