import type { NonChatModelReference } from "../../domain/model-preferences/non-chat-model-data";

/** Opaque Select identity; neither provider nor model IDs are parsed as path segments. */
export function nonChatModelChoiceValue(reference: NonChatModelReference): string {
  return JSON.stringify([reference.provider, reference.modelId]);
}
