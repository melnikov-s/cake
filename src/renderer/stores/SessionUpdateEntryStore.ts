import { child, createStore, Store } from "r-state-tree";
import type { SessionNotificationEntry } from "../../contracts/cake-chats/session-digest-reminder";
import { MessageReferencePreviewStore } from "./MessageReferencePreviewStore";

/** A batch entry owns only its disclosure; exact report bodies stay in the source reader. */
export class SessionUpdateEntryStore extends Store<{
  partId: string;
  entry: SessionNotificationEntry;
}> {
  expanded = false;

  toggle() {
    this.expanded = !this.expanded;
  }

  @child
  get source(): MessageReferencePreviewStore | undefined {
    const reference = this.props.entry.reference;
    return reference ? createStore(MessageReferencePreviewStore, { reference }) : undefined;
  }
}
