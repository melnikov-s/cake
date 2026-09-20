import { batch } from "r-state-tree";
import type { CakeChatControlUpdate } from "../../domain/cake-chats/cake-chat-data";
import type { CakeChatControls } from "../models/CakeChatControls";

export function applyCakeChatControlUpdate(model: CakeChatControls, update: CakeChatControlUpdate) {
  batch(() => {
    model.requests.splice(0, model.requests.length, ...update.requests);
  });
}
