import type { MessageOperationControl } from "../conversations/message-reference";

/** A private worker's transient, exact-reference read capability; never a transcript copy. */
export interface SubagentMessageAccess {
  readonly forward: (references: readonly string[]) => readonly string[];
  readonly control: MessageOperationControl;
}

export type SubagentMessageFactory = (
  recipientSessionId: string,
) => SubagentMessageAccess | undefined;
