import type { ProjectTodoAssociation } from "../../contracts/projects/project-todos";
import { observer, useStore } from "r-state-tree/react";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Typed work destinations keep public identity separate from private Pi session IDs. */
export const ProjectTodoWorkLink = observer(function ProjectTodoWorkLink({
  association,
}: {
  association: Exclude<ProjectTodoAssociation, { kind: "source" }>;
}) {
  const root = useStore(RootStore);
  const { href, Icon } = projectTodoAssociationDestination(association);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-normal leading-4 text-muted-foreground [&>a]:min-w-0 [&>a]:truncate [&>a]:font-normal [&>a]:no-underline [&>a:hover]:text-foreground [&>a:hover]:underline">
      {association.kind === "session" && (
        <SessionActivityIndicator
          activity={root.sessionMetadataStore.sessionWorkActivity(association.sessionId)}
        />
      )}
      <span className="shrink-0 [&>svg]:size-3">
        <Icon />
      </span>
      <MarkdownLink href={href}>{association.title}</MarkdownLink>
    </span>
  );
});
