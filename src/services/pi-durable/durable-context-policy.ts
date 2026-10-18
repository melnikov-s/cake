import { createHash } from "node:crypto";
import { defineDoc } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-durable-ai";
import {
  estimateContextTokens,
  estimateMessageTokens,
} from "@earendil-works/pi-durable-ai/utils/estimate";
import { getCurrentSystemMessage } from "@earendil-works/pi-durable-ai/utils/transcript";
import { Schema } from "effect";
import { CakeChatCacheRequest, CakeChatSummary } from "../../contracts/cake-chats/context-policy";
import { withoutDurableInputPresentation } from "./durable-input-presentation";

export const ContextPolicy = Schema.Struct({
  request: Schema.optionalKey(CakeChatCacheRequest),
  requestHead: Schema.NullOr(Schema.Int),
  requestSystem: Schema.optionalKey(Schema.String),
  lastSummary: Schema.optionalKey(CakeChatSummary),
});
export const ContextPolicyDoc = defineDoc<Schema.Schema.Type<typeof ContextPolicy>>({
  kind: "cake.chat-context-policy",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requestHead: null }),
});

/** Ignore timestamps, but invalidate freshness when instructions or tools change. */
export function durableSystemFingerprint(messages: readonly Message[]) {
  const system = getCurrentSystemMessage(messages);
  return createHash("sha256")
    .update(
      JSON.stringify(
        system
          ? {
              content: system.content,
              sections: system.sections,
              toolsAdded: system.toolsAdded,
              toolsRemoved: system.toolsRemoved,
            }
          : null,
      ),
    )
    .digest("hex");
}

/** Same authority/estimator as request admission. Lazy history is never counted. */
export function durableContextBreakdown(messages: readonly Message[], handoff?: Message) {
  const wire = messages.map((message) => withoutDurableInputPresentation(message));
  const system = getCurrentSystemMessage(wire);
  const systemTokens = system ? estimateMessageTokens(system) : 0;
  const memoryTokens = handoff
    ? estimateMessageTokens(withoutDurableInputPresentation(handoff))
    : 0;
  // Provider usage can be more accurate than text estimates. Attribute the remainder
  // (including request overhead) to the live conversation, not to browsed originals.
  const totalTokens = Math.max(systemTokens + memoryTokens, estimateContextTokens(wire).tokens);
  return {
    systemTokens,
    memoryTokens,
    messageTokens: totalTokens - systemTokens - memoryTokens,
    totalTokens,
  };
}
