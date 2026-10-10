import cakeChatPromptTemplate from "../pi/runtime/prompts/cake-chat.md?raw";
import commonPromptTemplate from "../pi/runtime/prompts/common.md?raw";
import { renderPromptTemplate } from "../pi/runtime/prompt-template";

const base = renderPromptTemplate(cakeChatPromptTemplate, {
  commonPrompt: renderPromptTemplate(commonPromptTemplate),
});

export const coordinatorSystemPrompt = (instructions: string) =>
  `${base}\n\n<cake-chat-instructions>\n${instructions}\n</cake-chat-instructions>`;
