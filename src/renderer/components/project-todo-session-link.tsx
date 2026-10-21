import { observer, useStore } from "r-state-tree/react";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Each actual session association keeps its own destination and work status. */
export const ProjectTodoSessionLink = observer(function ProjectTodoSessionLink({
  sessionId,
  title,
}: {
  sessionId: string;
  title: string;
}) {
  const root = useStore(RootStore);
  const { href, Icon } = projectTodoAssociationDestination({ kind: "session", sessionId, title });
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4 text-muted-foreground [&>a]:min-w-0 [&>a]:truncate [&>a]:font-normal [&>a]:no-underline [&>a:hover]:text-foreground [&>a:hover]:underline">
      <SessionActivityIndicator
        activity={root.sessionMetadataStore.sessionWorkActivity(sessionId)}
      />
      <span className="shrink-0 [&>svg]:size-3">
        <Icon />
      </span>
      <MarkdownLink href={href}>{title}</MarkdownLink>
    </span>
  );
});
