import type { AttachmentReferenceControl } from "../conversations/attachment-reference-control";
import type { TaskInputReference } from "../conversations/task-input";

/** Trusted composition binds the owner and one private worker's stable session identity. */
export interface SubagentAttachmentAccess {
  /** Authorize exact owner-selected IDs and bind durable recipient access, without reading payloads. */
  readonly forward: (
    inputRefs: readonly string[],
    signal: AbortSignal,
  ) => Promise<readonly TaskInputReference[]>;
  /** Lists/reads only this recipient's explicitly granted inputs, never the owner's whole vault. */
  readonly control: AttachmentReferenceControl;
}

export type SubagentAttachmentFactory = (
  ownerSessionId: string,
  recipientSessionId: string,
) => SubagentAttachmentAccess;
