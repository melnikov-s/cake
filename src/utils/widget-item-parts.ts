import type { Attachment, UiPart } from "../contracts/conversations/session-contract";

type WidgetItem = Extract<Attachment, { kind: "widget-item" }>;
type AttachmentPart = Extract<UiPart, { kind: "attachment" }>;

/** One transcript projection for sent, queued, optimistic and draft widget items. */
export function widgetItemPart(id: string, attachment: WidgetItem): AttachmentPart {
  return {
    id,
    kind: "attachment",
    name: attachment.name,
    mediaType: "application/json",
    attachmentKind: "widget-item",
    widgetItem: {
      itemId: attachment.itemId,
      widget: attachment.widget,
      ...(attachment.data !== undefined ? { data: attachment.data } : null),
    },
  };
}

/** Restores an edited/failed message's widget item into the composer. */
export function widgetItemFromPart(part: AttachmentPart): WidgetItem | undefined {
  if (part.attachmentKind !== "widget-item" || !part.widgetItem) return undefined;
  return {
    kind: "widget-item",
    name: part.name,
    itemId: part.widgetItem.itemId,
    widget: part.widgetItem.widget,
    ...(part.widgetItem.data !== undefined ? { data: part.widgetItem.data } : null),
  };
}
