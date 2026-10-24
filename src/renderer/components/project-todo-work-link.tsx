import type { ProjectTodoAssociation } from "../../contracts/projects/project-todos";
import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import { observer, useStore } from "r-state-tree/react";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { cn } from "../lib/utils";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { SessionActivityIndicator } from "./session-activity-indicator";

/** Typed work and reference chips keep public identity separate from private Pi session IDs. */
export const ProjectTodoWorkLink = observer(function ProjectTodoWorkLink({
  association,
}: {
  association: ProjectTodoAssociation;
}) {
  const root = useStore(RootStore);
  const { href, Icon } = projectTodoAssociationDestination(association);
  const isSource = association.kind === "source";
  return (
    <span
      className={cn(
        "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-normal leading-4 [&>a]:min-w-0 [&>a]:truncate [&>a]:font-normal [&>a]:leading-4 [&>a]:no-underline [&>a:hover]:text-foreground [&>a:hover]:underline [&_a>svg]:hidden",
        isSource
          ? "bg-muted/75 text-muted-foreground"
          : "border border-border/80 bg-background/80 text-foreground/90 shadow-2xs",
      )}
    >
      {association.kind === "session" && (
        <SessionActivityIndicator
          activity={root.sessionMetadataStore.sessionWorkActivity(association.sessionId)}
        />
      )}
      <span className="shrink-0 text-muted-foreground [&>svg]:size-3">
        <Icon />
      </span>
      <MarkdownLink
        href={href}
        onOpenSourceLocation={
          isSource
            ? (location) =>
                void root.projectWorkbenchStore.presentationStore.openFile(
                  editorLocationFromPath(location),
                )
            : undefined
        }
      >
        {association.title}
      </MarkdownLink>
    </span>
  );
});
