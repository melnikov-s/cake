import { MEMORY_COMPACTOR_PROMPT } from "./durable-memory-policy";
import cakeChatPromptTemplate from "../pi/runtime/prompts/cake-chat.md?raw";
import commonPromptTemplate from "../pi/runtime/prompts/common.md?raw";
import { renderPromptTemplate } from "../pi/runtime/prompt-template";

export const coordinatorSystemPrompt = (
  instructions: string,
  cakeDocsDirectory: string,
  companion = false,
) => {
  const base = companion
    ? `${renderPromptTemplate(commonPromptTemplate)}\n\nCake documentation directory: ${cakeDocsDirectory}. Read the matching guide before launches, sends, settings changes or scheduling. Use cake {} to discover topics and <operation>.help for exact contracts; never guess arguments. Prefer direct Cake navigation and short answers, not delegation for quick lookups.`
    : renderPromptTemplate(cakeChatPromptTemplate, {
        commonPrompt: renderPromptTemplate(commonPromptTemplate),
        cakeDocsDirectory,
      });
  return `${base}\n\n${MEMORY_COMPACTOR_PROMPT}\n\n<cake-chat-instructions>\n${instructions}\n</cake-chat-instructions>`;
};
