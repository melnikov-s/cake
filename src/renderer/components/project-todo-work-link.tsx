import { parseSessionLink } from "../../contracts/conversations/message-reference";
import type { ProjectTodoAssociation } from "../../contracts/projects/project-todos";
import { editorLocationFromPath } from "../../contracts/editor/editor-location";
import { observer, useStore } from "r-state-tree/react";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { cn } from "../lib/utils";
import { RootStore } from "../stores/RootStore";
import { MarkdownLink } from "./ai-elements/markdown";
import { SessionPurposeIndicator } from "./ui/session-purpose-indicator";
import { SessionActivityIndicator } from "./session-activity-indicator";
import { CommitChangeStatsText } from "./ui/commit-change-stats";

/** Typed work and reference rows keep public identity separate from private Pi session IDs. */
export const ProjectTodoWorkLink = observer(function ProjectTodoWorkLink({
  association,
}: {
  association: ProjectTodoAssociation;
}) {
  const root = useStore(RootStore);
  const { href, Icon } = projectTodoAssociationDestination(association);
  const isSource = association.kind === "source";
  const sessionId = parseSessionLink(href)?.sessionId;
  const purpose = sessionId
    ? (root.sessionCatalogStore.sessionPurpose(sessionId) ??
      (association.kind === "session" && root.sessionCatalogStore.backgroundSignalsLoaded
        ? "user"
        : undefined))
    : undefined;
  const readiness =
    association.kind === "session"
      ? root.sessionMetadataStore.sessionMergeReadiness(association.sessionId)
      : undefined;
  const mergeStatus = readiness
    ? readiness.outcome?.merged
      ? readiness.outcome.resolutionSucceeded
        ? `Merged and resolved · ${readiness.outcome.message}`
        : `Merged; resolution failed: ${readiness.outcome.message}`
      : readiness.state === "failed"
        ? `Merge failed: ${readiness.message ?? readiness.outcome?.message ?? "Open the session for details"}`
        : readiness.state === "landing"
          ? "Landing…"
          : `Ready to Merge${readiness.message ? ` · ${readiness.message}` : ""}`
    : undefined;
  return (
    <span
      className={cn(
        "flex w-full min-w-0 items-start gap-1.5 px-2 py-0.5 text-xs font-normal leading-4 [&_a>svg]:hidden",
        isSource ? "text-muted-foreground" : "text-foreground/90",
      )}
    >
      <span className="flex h-4 shrink-0 items-center gap-1.5">
        {association.kind === "session" && (
          <SessionActivityIndicator
            activity={root.sessionMetadataStore.sessionWorkActivity(association.sessionId)}
          />
        )}
        <span className="text-muted-foreground [&>svg]:size-3">
          {purpose ? <SessionPurposeIndicator purpose={purpose} /> : <Icon />}
        </span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5 [&>a]:max-w-full [&>a]:min-w-0 [&>a]:[overflow-wrap:anywhere] [&>a]:font-normal [&>a]:leading-4 [&>a]:no-underline [&>a:hover]:text-foreground [&>a:hover]:underline">
        <MarkdownLink
          href={href}
          presentation="text"
          showSessionPurpose={false}
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
        {association.kind === "session" && (
          <CommitChangeStatsText
            className="text-muted-foreground"
            stats={root.sessionMetadataStore.sessionCommitStats(association.sessionId)}
          />
        )}
        {mergeStatus && (
          <span
            aria-label={`Merge status for ${association.title}`}
            className={cn(
              "whitespace-pre-wrap break-words",
              readiness?.state === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {mergeStatus}
          </span>
        )}
      </span>
    </span>
  );
});
