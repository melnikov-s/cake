import subagentPromptTemplate from "./runtime/prompts/subagent.md?raw";
import { renderPromptTemplate } from "./runtime/prompt-template";

export function subagentSystemPrompt(additionalInstructions?: string): string {
  return renderPromptTemplate(subagentPromptTemplate, {
    additionalInstructionsSection: additionalInstructions
      ? `Additional instructions:\n\n${additionalInstructions}`
      : "",
  });
}
