import { MEMORY_COMPACTOR_PROMPT } from "./durable-memory-policy";
import cakeChatPromptTemplate from "../pi/runtime/prompts/cake-chat.md?raw";
import commonPromptTemplate from "../pi/runtime/prompts/common.md?raw";
import { renderPromptTemplate } from "../pi/runtime/prompt-template";

export const coordinatorSystemPrompt = (
  instructions: string,
  cakeDocsDirectory: string,
  companion = false,
  coreOperations = "",
  globalExecution = false,
) => {
  const global = globalExecution && !companion;
  const common = renderPromptTemplate(commonPromptTemplate, {
    settingsFilePolicy: global
      ? "Never edit Cake/Pi managed settings files or credentials; use supported controls. Ordinary external user configuration needs an explicit task and exact target authorization."
      : "Never edit settings files.",
  });
  const base = companion
    ? `${common}\n\nTask guide: ${cakeDocsDirectory}/index.md; follow relevant links only. Use known commands directly; <operation>.help for unfamiliar contracts. Answer/navigate directly.`
    : renderPromptTemplate(cakeChatPromptTemplate, {
        commonPrompt: common,
        cakeDocsDirectory,
        coreOperations,
        fileExecutionPolicy: global
          ? "Small, explicitly user-authorized non-project edits: use read, then edit/write with exact target paths; preserve unrelated content and verify changes. This includes ordinary external user configuration, not Cake/Pi managed settings or credentials. No project registration required. Files are on Cake's backend host, not necessarily the user's machine; clarify ambiguous remote/local-config requests before writing. Authorization is task/target-specific, never blanket permission. Longer non-project work: subagents.start {task:\"exact authorized task, absolute targets, limits and checks\", allowMutations:true}; omit projectPath for a fresh bounded worker. This authorized operational delegation needs no separate approval. Do not reuse a read-only research handle or fork for writes. Shell tools are not sandboxes. Standalone conversations are optional for separate resumable discussion, never a prerequisite. Ask before destructive, unclear or escalated actions."
          : "Project Chat stays read-only; use Global Cake Chat for non-project edits.",
      });
  return `${base}\n\n${MEMORY_COMPACTOR_PROMPT}\n\n<cake-chat-instructions>\n${instructions}\n</cake-chat-instructions>`;
};
