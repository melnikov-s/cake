import { Store, computed, observable } from "r-state-tree";
import type { Annotation, Attachment, UiPart } from "../../ipc/session-contract";

interface PendingUserMessage {
  id: string;
  canonicalPartCount: number;
  expectedOccurrence: number;
  text: string;
  attachments: Attachment[];
  parts: UiPart[];
}

export interface OptimisticUserMessagesStoreProps {
  canonicalParts(): UiPart[];
}

/** Owns optimistic user-message projection until the canonical transcript contains it. */
export class OptimisticUserMessagesStore extends Store<OptimisticUserMessagesStoreProps> {
  readonly pending: PendingUserMessage[] = observable([]);

  constructor(props: OptimisticUserMessagesStore["props"]) {
    super(props);
    this.effect(() => {
      const reconciledIds = this.pending
        .filter(
          (message) =>
            this.occurrenceCount(message.text, message.parts) >= message.expectedOccurrence,
        )
        .map((message) => message.id);
      for (const id of reconciledIds) this.remove(id);
    });
  }

  @computed
  get parts(): UiPart[] {
    const canonical = this.props.canonicalParts();
    if (this.pending.length === 0) return canonical;
    const parts = [...canonical];
    let offset = 0;
    for (const message of this.pending) {
      if (this.occurrenceCount(message.text, message.parts) >= message.expectedOccurrence) continue;
      parts.splice(
        Math.min(message.canonicalPartCount + offset, parts.length),
        0,
        ...message.parts,
      );
      offset += message.parts.length;
    }
    return parts;
  }

  add(
    id: string,
    text: string,
    attachments: Attachment[],
    deliveryState: "sending" | "steering" | "queued",
    renderUserMessageAsMarkdown: boolean,
  ) {
    const attachmentParts = attachments.flatMap((attachment, index): UiPart[] => {
      if (attachment.kind === "image")
        return [
          {
            id: `optimistic-user-${id}-attachment-${index}`,
            kind: "attachment",
            name: attachment.name,
            mediaType: attachment.mimeType,
            attachmentKind: "image",
            data: attachment.data,
          },
        ];
      if (attachment.kind === "source")
        return [
          {
            id: `optimistic-user-${id}-attachment-${index}`,
            kind: "attachment",
            name: attachment.name,
            mediaType: "text/plain",
            attachmentKind: "source",
            location: attachment.location,
          },
        ];
      if (attachment.kind === "annotation")
        return [
          {
            id: `optimistic-user-${id}-annotation-${index}`,
            kind: "annotation",
            annotations: attachment.annotations,
          },
        ];
      return [];
    });
    const parts: UiPart[] = [
      ...(text
        ? [
            {
              id: `optimistic-user-${id}`,
              kind: "text" as const,
              role: "user" as const,
              text,
              status: "complete" as const,
              renderAs: renderUserMessageAsMarkdown ? ("markdown" as const) : undefined,
              deliveryState,
            },
          ]
        : []),
      ...attachmentParts,
    ];
    const earlierPendingCount = this.pending.filter(
      (message) => message.text === text && this.sameNonTextIdentity(message.parts, parts),
    ).length;
    this.pending.push({
      id,
      canonicalPartCount: this.props.canonicalParts().length,
      expectedOccurrence: this.occurrenceCount(text, parts) + earlierPendingCount + 1,
      text,
      attachments: attachments.map((attachment) => ({ ...attachment })),
      parts,
    });
    return id;
  }

  remove(id: string) {
    const index = this.pending.findIndex((message) => message.id === id);
    if (index < 0) return undefined;
    const [message] = this.pending.splice(index, 1);
    return message
      ? {
          text: message.text,
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        }
      : undefined;
  }

  removeByDeliveryState(deliveryState: "sending" | "steering" | "queued") {
    const ids = this.pending
      .filter((message) =>
        message.parts.some((part) => part.kind === "text" && part.deliveryState === deliveryState),
      )
      .map((message) => message.id);
    for (const id of ids) this.remove(id);
  }

  clear() {
    this.pending.splice(0);
  }

  private occurrenceCount(text: string, parts: UiPart[]) {
    const canonical = this.props.canonicalParts();
    if (text)
      return canonical.filter(
        (part) =>
          part.kind === "text" &&
          part.role === "user" &&
          part.status === "complete" &&
          part.text === text,
      ).length;
    const annotation = parts.find(
      (part): part is Extract<UiPart, { kind: "annotation" }> => part.kind === "annotation",
    );
    if (annotation) {
      const ids = annotation.annotations.map((item: Annotation) => item.id).join("\u0000");
      return canonical.filter(
        (part) =>
          part.kind === "annotation" &&
          part.annotations.map((item) => item.id).join("\u0000") === ids,
      ).length;
    }
    const attachment = parts.find(
      (part): part is Extract<UiPart, { kind: "attachment" }> => part.kind === "attachment",
    );
    return attachment?.data
      ? canonical.filter(
          (part) =>
            part.kind === "attachment" &&
            part.attachmentKind === attachment.attachmentKind &&
            part.data === attachment.data,
        ).length
      : 0;
  }

  private sameNonTextIdentity(left: UiPart[], right: UiPart[]) {
    if (left.some((part) => part.kind === "text")) return true;
    const leftAnnotation = left.find(
      (part): part is Extract<UiPart, { kind: "annotation" }> => part.kind === "annotation",
    );
    const rightAnnotation = right.find(
      (part): part is Extract<UiPart, { kind: "annotation" }> => part.kind === "annotation",
    );
    if (leftAnnotation || rightAnnotation)
      return (
        leftAnnotation?.annotations.map((item) => item.id).join("\u0000") ===
        rightAnnotation?.annotations.map((item) => item.id).join("\u0000")
      );
    const leftAttachment = left.find(
      (part): part is Extract<UiPart, { kind: "attachment" }> => part.kind === "attachment",
    );
    const rightAttachment = right.find(
      (part): part is Extract<UiPart, { kind: "attachment" }> => part.kind === "attachment",
    );
    return (
      leftAttachment?.attachmentKind === rightAttachment?.attachmentKind &&
      leftAttachment?.data === rightAttachment?.data
    );
  }
}
