import { observer } from "r-state-tree/react";
import { sessionLink } from "../../../contracts/conversations/message-reference";
import { sessionDisplayId } from "../../lib/session-display-id";
import { useMarkdownLinkActions } from "../ai-elements/markdown";
import { Link } from "./link";

/** Compact session identity; the destination and tooltip always retain the full ID. */
export const SessionIdLink = observer(function SessionIdLink({
  sessionId,
  knownSessionIds,
}: {
  sessionId: string;
  knownSessionIds?: readonly string[];
}) {
  const actions = useMarkdownLinkActions();
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
      {sessionDisplayId(sessionId, ids)}
    </Link>
  );
});
