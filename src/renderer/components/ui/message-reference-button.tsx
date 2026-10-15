import { messageReference } from "../../../contracts/conversations/message-reference";
import { CopyReferenceButton } from "./copy-reference-button";

/** Copies a durable Pi message identity, not the current renderer part identity. */
export function MessageReferenceButton({
  sessionId,
  entryId,
  className,
}: {
  sessionId: string;
  entryId: string;
  className?: string;
}) {
  return (
    <CopyReferenceButton
      reference={messageReference(sessionId, entryId)}
      label="message link"
      className={className}
    />
  );
}
