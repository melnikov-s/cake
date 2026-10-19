import { expect, it } from "vitest";
import { coordinatorSystemPrompt } from "../../../src/services/pi-durable/coordinator-system-prompt";
import modelDocumentation from "../../../docs/agent/models.md?raw";
import presentationDocumentation from "../../../docs/agent/presentation.md?raw";

it("shared presentation guidance requires inline images rather than clickable links", () => {
  const prompt = presentationDocumentation;
  expect(prompt).toContain("Always present images, screenshots, and visual previews inline");
  expect(prompt).toContain("never as plain clickable links");
  expect(prompt).toContain("![Description](working-directory-relative-image-path)");
  expect(prompt).toContain("native inline image output");
});

it("Cake Chat keeps inline images in its kernel and gates detailed presentation guidance", () => {
  const prompt = coordinatorSystemPrompt("", "/cake/docs");
  expect(prompt).toContain("Show images inline");
  expect(prompt).toContain("read `presentation.md`");
});

it("Project Session saved-image documentation also requires inline presentation", () => {
  expect(modelDocumentation).toContain("display the saved image inline with Markdown image syntax");
});
