import { parseSessionLink, sessionLink } from "../../contracts/conversations/message-reference";
import type { ProjectTodoAssociation } from "../../contracts/projects/project-todos";
import { parseSourceLocation } from "../../utils/source-location";
import { ArtifactIcon, ChatIcon, LinkIcon, MarkdownIcon, TreeIcon } from "../components/ui/icons";

/** Presentation only: MarkdownLink still owns destination inspection and navigation. */
export function projectTodoAssociationDestination(association: ProjectTodoAssociation) {
  const href =
    association.kind === "session" ? sessionLink(association.sessionId) : association.ref;
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
