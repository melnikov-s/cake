import { applySnapshot, batch } from "r-state-tree";
import type { ScheduledMessageUpdate } from "../../domain/scheduled-message-data";
import type { Session } from "../models/Session";
import { ScheduledMessage } from "../models/ScheduledMessage";

export function applyScheduledMessageUpdate(model: Session, update: ScheduledMessageUpdate) {
  if (update._tag === "Snapshot") {
    batch(() => {
      model.scheduledMessages.splice(
        0,
        model.scheduledMessages.length,
        ...update.messages.map((message) => ScheduledMessage.create(message)),
      );
    });
    return;
  }
  const event = update.event;
  batch(() => {
    if (event._tag === "Removed") {
      const index = model.scheduledMessages.findIndex((message) => message.id === event.id);
      if (index >= 0) model.scheduledMessages.splice(index, 1);
      return;
    }
    const index = model.scheduledMessages.findIndex((message) => message.id === event.message.id);
    if (index < 0) model.scheduledMessages.push(ScheduledMessage.create(event.message));
    else applySnapshot(model.scheduledMessages[index]!, event.message);
  });
}
