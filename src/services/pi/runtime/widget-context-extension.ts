import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";

/** Preserve inherited prompt sections; Pi appends task/tool deltas rather than replacing history. */
export function createWidgetContextExtension(
  manager: SessionManager,
  instructions: string,
): InlineExtension {
  const inherited = getCurrentSystemMessage(manager.buildSessionContext().messages);
  const sections: Record<string, string> = {};
  for (const [name, content] of Object.entries(inherited?.sections ?? {})) {
    if (
      name === "preamble" ||
      name === "tools" ||
      name === "skills" ||
      name === "widget_task" ||
      content === null
    )
      continue;
    const opening = `<${name}>\n`;
    const closing = `\n</${name}>`;
    sections[name] =
      content.startsWith(opening) && content.endsWith(closing)
        ? content.slice(opening.length, -closing.length)
        : content;
  }
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      options.customPrompt =
        inherited?.sections?.preamble ?? (inherited ? getSystemMessageText(inherited) : undefined);
      options.appendSystemPrompt = "";
      options.contextFiles = [];
      options.sections = {
        ...sections,
        widget_task: `This is a restricted artifact-generation branch of the preceding conversation. Use its inherited context to satisfy the assignment below. Only scoped candidate tools and skill-resource reads are available when declared. No application controls, unrestricted filesystem tools, package installation, or session management are available. Candidate edits are private until successful rendering, review, and publication. Read the relevant skill instructions and resources before implementing a specialized artifact.\n\n${instructions}`,
      };
    });
  };
}
