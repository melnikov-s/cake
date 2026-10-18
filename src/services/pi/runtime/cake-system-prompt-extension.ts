import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import { retainRelocatedForkContext } from "./fork-context";
import { withoutTerminalDocumentation } from "./pi-documentation";

/** Retain Pi's generated prompt, trim terminal docs, and avoid relocation-only fork reinjection. */
export function createCakeSystemPromptExtension(): ExtensionFactory {
  return (pi) => {
    pi.on("before_agent_start", (event, ctx) => {
      const options = event.systemPromptOptions;
      if (
        !options.customPrompt &&
        !options.forceSystemPrompt &&
        ctx.sessionManager.getHeader()?.parentSession
      ) {
        const inherited = getCurrentSystemMessage(
          ctx.sessionManager.buildSessionProjection().messages,
        );
        if (inherited) retainRelocatedForkContext(event, inherited);
      }
      // Custom prompts and extension-authored documentation remain their owner's policy.
      if (options.customPrompt || options.sections.docs) return;
      const docs = event.systemPrompt.match(/^<docs>\n([\s\S]*?)\n<\/docs>/m)?.[1];
      if (!docs) return;
      options.sections.docs = withoutTerminalDocumentation(docs);
    });
  };
}
