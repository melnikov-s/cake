import { parseSubagentLink, subagentLink } from "../../contracts/subagents/subagent-reference";
import { parseSessionLink, sessionLink } from "../../contracts/conversations/message-reference";
import type { ProjectTodoAssociation } from "../../contracts/projects/project-todos";
import { parseSourceLocation } from "../../utils/source-location";
import {
  ArtifactIcon,
  ChatIcon,
  LinkIcon,
  MarkdownIcon,
  TreeIcon,
  SparkleIcon,
} from "../components/ui/icons";

/** Presentation only: MarkdownLink still owns destination inspection and navigation. */
export function projectTodoAssociationDestination(association: ProjectTodoAssociation) {
  const href =
    association.kind === "session"
      ? sessionLink(association.sessionId)
      : association.kind === "subagent"
        ? subagentLink(association.parentSessionId, association.handleId)
        : association.ref;
  if (parseSubagentLink(href)) return { href, Icon: SparkleIcon };
  const session = parseSessionLink(href);
  if (session)
    return {
      href,
      Icon: session.messageId ? ChatIcon : session.attachmentId ? ArtifactIcon : TreeIcon,
    };
  if (href.startsWith("cake://artifact/")) return { href, Icon: ArtifactIcon };
  const source = parseSourceLocation(href);
  if (source)
    return {
      href,
      Icon: /\.(?:md|markdown)$/i.test(source.path) ? MarkdownIcon : ArtifactIcon,
    };
  return { href, Icon: LinkIcon };
}
