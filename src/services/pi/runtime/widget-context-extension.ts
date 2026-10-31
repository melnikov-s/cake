import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SystemMessage } from "@earendil-works/pi-ai";

/**
 * Rebuilds the inherited system prompt exactly. Pi diffs the rebuilt sections
 * against the transcript and records any difference as a system update, which
 * makes providers re-read the whole inherited conversation instead of reusing
 * its prompt cache. The widget assignment therefore travels in the user
 * message, never in the system prompt.
 */
export function createWidgetContextExtension(inherited: SystemMessage): InlineExtension {
  const sections = inherited.sections;
  if (!sections?.preamble)
    throw new Error(
      "The parent conversation has no structured system prompt. A widget side chat must reuse it unchanged to keep its prompt cache, so widget generation is unavailable here.",
    );
  const preamble = sections.preamble;
  const custom: Record<string, string> = {};
  for (const [name, content] of Object.entries(sections)) {
    if (name === "preamble" || content === null || content === undefined) continue;
    const opening = `<${name}>\n`;
    const closing = `\n</${name}>`;
    custom[name] =
      content.startsWith(opening) && content.endsWith(closing)
        ? content.slice(opening.length, -closing.length)
        : content;
  }
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      // Only inherited sections: nothing generated from this runtime's own resources.
      options.customPrompt = preamble;
      options.appendSystemPrompt = "";
      options.contextFiles = [];
      options.skills = [];
      options.sections = { ...custom };
    });
  };
}
