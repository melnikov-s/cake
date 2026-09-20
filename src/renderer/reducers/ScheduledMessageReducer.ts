import { applySnapshot, batch } from "r-state-tree";
import type { ScheduledMessageUpdate } from "../../domain/scheduled-messages/scheduled-message-data";
import type { ScheduledMessageCatalog } from "../models/ScheduledMessageCatalog";
import { ScheduledMessage } from "../models/ScheduledMessage";

export function applyScheduledMessageUpdate(
  model: ScheduledMessageCatalog,
  update: ScheduledMessageUpdate,
) {
  if (update._tag === "Snapshot") {
    batch(() => {
      model.messages.splice(
        0,
        model.messages.length,
        ...update.messages.map((message) => ScheduledMessage.create(message)),
      );
    });
    return;
  }
  const event = update.event;
  batch(() => {
    if (event._tag === "Removed") {
      const index = model.messages.findIndex((message) => message.id === event.id);
      if (index >= 0) model.messages.splice(index, 1);
      return;
    }
    const index = model.messages.findIndex((message) => message.id === event.message.id);
    if (index < 0) model.messages.push(ScheduledMessage.create(event.message));
    else applySnapshot(model.messages[index]!, event.message);
  });
}
