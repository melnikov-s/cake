import researchPromptTemplate from "./runtime/prompts/general-research.md?raw";
import projectInvestigationPromptTemplate from "./runtime/prompts/project-investigation.md?raw";
import subagentPromptTemplate from "./runtime/prompts/subagent.md?raw";
import investigationOnlyPolicy from "./runtime/prompts/worker-investigation-only.md?raw";
import mutationPolicy from "./runtime/prompts/worker-mutations.md?raw";
import { renderPromptTemplate } from "./runtime/prompt-template";

/** Options shared by Cake Chat workers; mutations are opt-in per worker. */
export interface CakeChatWorkerPromptOptions {
  readonly allowMutations: boolean;
}

const workerMutationPolicy = ({ allowMutations }: CakeChatWorkerPromptOptions) =>
  (allowMutations ? mutationPolicy : investigationOnlyPolicy).trim();

/** Isolated system prompt for a project-free Cake Chat general researcher. */
export function researchSystemPrompt(options: CakeChatWorkerPromptOptions): string {
  return renderPromptTemplate(researchPromptTemplate, {
    mutationPolicy: workerMutationPolicy(options),
  });
}

/** Appended policy for a Cake Chat project investigator bound to a registered root. */
export function projectInvestigationSystemPrompt(options: CakeChatWorkerPromptOptions): string {
  return renderPromptTemplate(projectInvestigationPromptTemplate, {
    mutationPolicy: workerMutationPolicy(options),
  });
}

export function subagentSystemPrompt(additionalInstructions?: string): string {
  return renderPromptTemplate(subagentPromptTemplate, {
    additionalInstructionsSection: additionalInstructions
      ? `Additional instructions:\n\n${additionalInstructions}`
      : "",
  });
}
