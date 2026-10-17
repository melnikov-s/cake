import { relative } from "node:path";
import { Schema } from "effect";
import type { ContextInspectionNode } from "../../../contracts/conversations/context-inspection";
import { jsonObjectSchema } from "../../../contracts/serialization/json-contract";
import { projectRuntimeSystemPrompt } from "./system-context-projection";

/** Display literal content without interpreting prompt text as UI instructions or Markdown. */
function contextMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2) ?? "";
  return content
    .map((block: unknown) => {
      if (
        Schema.is(jsonObjectSchema)(block) &&
        block.type === "text" &&
        typeof block.text === "string"
      )
        return block.text;
      return JSON.stringify(block, null, 2) ?? "";
    })
    .join("\n\n");
}

export function contextMessage(id: string, role: string, content: unknown): ContextInspectionNode {
  return {
    id,
    title:
      role === "user"
        ? "You"
        : role === "assistant"
          ? "Assistant"
          : role === "toolResult"
            ? "Tool result"
            : role,
    text: contextMessageText(content),
    kind: "original",
  };
}

/** Use the included instruction bytes, never reread a file that may have changed since assembly. */
export function contextSources(
  prompt: string,
  tools: readonly unknown[],
  cwd: string,
): ContextInspectionNode[] {
  const sources: ContextInspectionNode[] = [];
  const toolText: string[] = [];
  const instructions = /<cake-chat-instructions>\n([\s\S]*?)\n<\/cake-chat-instructions>/;
  const globalInstructions = prompt.match(instructions);
  const parts = projectRuntimeSystemPrompt(prompt.replace(instructions, ""));
  for (const part of parts) {
    if (part.title === "AGENTS.md") {
      let index = 0;
      for (const match of part.text.matchAll(
        /<project_instructions path="([^"]+)">\n([\s\S]*?)\n<\/project_instructions>/g,
      )) {
        const path = match[1]!;
        const local = relative(cwd, path);
        sources.push({
          id: `instructions-${index++}`,
          title: local.startsWith("..") ? path : local || path,
          source: path,
          text: match[2]!,
        });
      }
      if (!index) sources.push({ id: "instructions", title: "Instructions", text: part.text });
    } else if (part.title === "Tools") {
      toolText.push(part.text);
    } else {
      sources.push({
        id: part.id,
        title: part.title === "System" ? "System prompt" : part.title,
        text: part.text,
      });
    }
  }
  if (globalInstructions?.[1]?.trim())
    sources.push({
      id: "cake-instructions",
      title: "Cake Chat instructions",
      text: globalInstructions[1],
    });
  if (tools.length) toolText.push(JSON.stringify(tools, null, 2));
  if (toolText.length) sources.push({ id: "tools", title: "Tools", text: toolText.join("\n\n") });
  return sources;
}
