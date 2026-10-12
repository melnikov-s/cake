import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import modelDocumentation from "../../../docs/agent/models.md?raw";
import presentationDocumentation from "../../../docs/agent/presentation.md?raw";

it.each([
  ["Project Session documentation", presentationDocumentation],
  ["Cake Chat", coordinatorSystemPrompt("")],
])("%s instructs agents to display images inline rather than as clickable links", (_, prompt) => {
  expect(prompt).toContain("Always present images, screenshots, and visual previews inline");
  expect(prompt).toContain("never as plain clickable links");
  expect(prompt).toContain("![Description](working-directory-relative-image-path)");
  expect(prompt).toContain("native inline image output");
});

it("Project Session saved-image documentation also requires inline presentation", () => {
  expect(modelDocumentation).toContain("display the saved image inline with Markdown image syntax");
});
