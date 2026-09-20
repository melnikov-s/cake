import { batch } from "r-state-tree";
import type { CakeChatControlUpdate } from "../../domain/cake-chats/cake-chat-data";
import type { CakeChatControls } from "../models/CakeChatControls";

export function applyCakeChatControlUpdate(model: CakeChatControls, update: CakeChatControlUpdate) {
  batch(() => {
    if (update._tag === "Snapshot") {
      model.requests.splice(0, model.requests.length, ...update.requests);
      return;
    }
    if (
      !model.requests.some(
        ({ controlRequestId }) => controlRequestId === update.request.controlRequestId,
      )
    )
      model.requests.push(update.request);
  });
}
