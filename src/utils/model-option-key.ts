import type { ModelOption } from "../contracts/conversations/session-contract";

export function modelOptionKey(option: Pick<ModelOption, "provider" | "id">) {
  return JSON.stringify([option.provider, option.id]);
}
