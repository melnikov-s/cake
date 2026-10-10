export type CrossSessionDelivery = "prompt" | "queue" | "steer";

export type CrossSessionDeliveryStatus =
  | "accepted"
  | "queued"
  | "delivered"
  | "processing"
  | "answered"
  | "failed"
  | "canceled";

export interface CrossSessionDeliveryProjection {
  readonly messageState: "missing" | "queued" | "projected";
  readonly turnState: "unknown" | "active" | "complete" | "failed" | "aborted";
  readonly assistantResponseProjected: boolean;
}

/** Resolves Cake's delivery vocabulary from neutral facts about the Pi projection. */
export function deriveCrossSessionDeliveryStatus(
  delivery: CrossSessionDelivery,
  projection: CrossSessionDeliveryProjection,
): CrossSessionDeliveryStatus {
  if (projection.messageState === "queued") return "queued";
  if (projection.turnState === "failed") return "failed";
  if (projection.turnState === "aborted") return "canceled";
  if (projection.turnState === "complete")
    return projection.assistantResponseProjected ? "answered" : "delivered";
  if (projection.messageState === "projected" && projection.turnState === "active")
    return "processing";
  if (projection.messageState === "projected") return "delivered";
  return delivery === "queue" ? "queued" : "accepted";
}

export interface CoordinationMessage {
  readonly messageId: string;
  readonly senderSessionId: string;
  readonly targetSessionId: string;
  turnId: string;
  readonly delivery: CrossSessionDelivery;
  status: CrossSessionDeliveryStatus;
}

export interface CoordinationThread {
  readonly threadId: string;
  readonly participants: [string, string];
  readonly maxMessages?: number;
  readonly messages: CoordinationMessage[];
  state: "open" | "closed";
}
