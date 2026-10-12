import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Retain Pi's generated prompt; only remove terminal-only entries from its docs section. */
export function createCakeSystemPromptExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event) => {
      const options = event.systemPromptOptions;
      // Custom prompts and extension-authored documentation remain their owner's policy.
      if (options.customPrompt || options.sections.docs) return;
      const docs = event.systemPrompt.match(/^<docs>\n([\s\S]*?)\n<\/docs>/m)?.[1];
      if (!docs) return;
      options.sections.docs = docs
        .replace(", themes, skills, or TUI", ", or skills")
        .replace(", themes (docs/themes.md)", "")
        .replace(", TUI components (docs/tui.md)", "")
        .replace(", keybindings (docs/keybindings.md)", "")
        .replace(" (e.g., tui.md for TUI API details)", "");
    });
  };
}
