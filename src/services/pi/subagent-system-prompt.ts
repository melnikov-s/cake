import researchPromptTemplate from "./runtime/prompts/general-research.md?raw";
import subagentPromptTemplate from "./runtime/prompts/subagent.md?raw";
import { renderPromptTemplate } from "./runtime/prompt-template";

export const researchSystemPrompt = researchPromptTemplate;

export function subagentSystemPrompt(additionalInstructions?: string): string {
  return renderPromptTemplate(subagentPromptTemplate, {
    additionalInstructionsSection: additionalInstructions
      ? `Additional instructions:\n\n${additionalInstructions}`
      : "",
  });
}
