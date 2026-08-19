import type { ModelOption } from "../ipc/session-contract";

export function modelOptionKey(option: Pick<ModelOption, "provider" | "id">) {
  return JSON.stringify([option.provider, option.id]);
}
