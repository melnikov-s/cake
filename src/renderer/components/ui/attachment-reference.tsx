import type { TaskInputReference } from "../../../contracts/conversations/task-input";
import { attachmentLink } from "../../../contracts/conversations/message-reference";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import { CopyReferenceButton } from "./copy-reference-button";
import { Link } from "./link";

/** Discoverable input metadata; clicks read only on the user's request. */
export function AttachmentReference({
  sessionId,
  reference,
}: {
  sessionId: string;
  reference: TaskInputReference;
}) {
  const actions = useMarkdownLinkActions();
  const href = attachmentLink(sessionId, reference.id);
  return (
    <div className="flex w-fit items-center gap-2 text-xs">
      <Link
        href={href}
        title={href}
        onClick={(event) => {
          event.preventDefault();
          actions?.openSession(sessionId, undefined, reference.id);
        }}
      >
        {reference.name}
      </Link>
      <CopyReferenceButton reference={href} label="attachment link" />
    </div>
  );
}
