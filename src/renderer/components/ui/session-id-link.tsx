import { observer } from "r-state-tree/react";
import { sessionLink } from "../../../contracts/conversations/message-reference";
import { sessionDisplayId } from "../../lib/session-display-id";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import { Link } from "./link";
import { SessionPurposeIndicator } from "./session-purpose-indicator";

/** Compact session identity; the destination and tooltip always retain the full ID. */
export const SessionIdLink = observer(function SessionIdLink({
  sessionId,
  knownSessionIds,
}: {
  sessionId: string;
  knownSessionIds?: readonly string[];
}) {
  const actions = useMarkdownLinkActions();
  const purpose = actions?.sessionPurpose?.(sessionId);
  const ids = [...(actions?.sessionIds?.() ?? []), ...(knownSessionIds ?? [])];
  return (
    <Link
      href={sessionLink(sessionId)}
      onClick={
        actions
          ? (event) => {
              event.preventDefault();
              actions.openSession(sessionId);
            }
          : undefined
      }
    >
      {purpose && <SessionPurposeIndicator purpose={purpose} className="mr-1" />}
      {sessionDisplayId(sessionId, ids)}
    </Link>
  );
});
