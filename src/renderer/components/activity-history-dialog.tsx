import { useId, useLayoutEffect, useRef, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import {
  activityKinds,
  type ActivityEntry,
  type ActivityKind,
} from "../../contracts/application/activity-history";
import { RootStore } from "../stores/RootStore";
import { Button } from "./ui/button";
import { DialogBackdrop, DialogContent, DialogTitle } from "./ui/dialog";
import { CloseIcon } from "./ui/icons";

const kindLabels = {
  notification: "Notifications",
  "agent-action": "Agent actions",
  "session-created": "Session creation",
  merge: "Merges",
  resolution: "Resolutions",
  automation: "Automations",
} satisfies Record<ActivityKind, string>;

const entryLabels = {
  notification: "Notification",
  "agent-action": "Agent action",
  "session-created": "Session created",
  merge: "Merge",
  resolution: "Resolution",
  automation: "Automation",
} satisfies Record<ActivityKind, string>;

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const filterClass =
  "h-8 min-w-0 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground";

export const ActivityHistoryDialog = observer(function ActivityHistoryDialog() {
  const root = useStore(RootStore);
  return root.activityHistoryStore.visible ? <ActivityHistoryPanel /> : null;
});

const ActivityHistoryPanel = observer(function ActivityHistoryPanel() {
  const root = useStore(RootStore);
  const store = root.activityHistoryStore;
  const projects = root.projectCatalogStore;
  const titleId = useId();
  const content = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const navigating = useRef(false);
  const [linkError, setLinkError] = useState<string>();
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const trap = (event: FocusEvent) => {
      if (event.target instanceof Node && !content.current?.contains(event.target))
        close.current?.focus();
    };
    document.addEventListener("focusin", trap);
    close.current?.focus();
    return () => {
      document.removeEventListener("focusin", trap);
      if (!navigating.current && previous instanceof HTMLElement && previous.isConnected)
        previous.focus();
    };
  }, []);

  const visit = async (open: () => void | boolean | Promise<void | boolean>) => {
    setLinkError(undefined);
    try {
      if ((await open()) === false) throw new Error("That destination is no longer available.");
      navigating.current = true;
      store.close();
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : "Could not open that destination.");
    }
  };
  const paths = projects.orderedProjectPaths;
  const projectOptions =
    store.projectPath && !paths.includes(store.projectPath) ? [...paths, store.projectPath] : paths;

  return (
    <DialogBackdrop aria-labelledby={titleId} onClose={() => store.close()}>
      <DialogContent
        ref={content}
        className="flex h-[min(40rem,85dvh)] max-w-2xl flex-col gap-3 overflow-hidden"
      >
        <header className="flex items-center justify-between gap-3">
          <DialogTitle id={titleId}>Activity history</DialogTitle>
          <Button
            ref={close}
            variant="ghost"
            size="sm"
            aria-label="Close Activity history"
            onClick={() => store.close()}
          >
            <CloseIcon />
          </Button>
        </header>
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            <label htmlFor={`${titleId}-project`}>Project</label>
            <select
              id={`${titleId}-project`}
              className={filterClass}
              value={store.projectPath === null ? "global" : (store.projectPath ?? "")}
              onChange={(event) =>
                store.setProject(
                  event.target.value === "global" ? null : event.target.value || undefined,
                )
              }
            >
              <option value="">All projects</option>
              <option value="global">No project</option>
              {projectOptions.map((path) => (
                <option key={path} value={path}>
                  {projects.nameForPath(path)}
                </option>
              ))}
            </select>
          </div>
          <div className="grid min-w-0 gap-1 text-xs text-muted-foreground">
            <label htmlFor={`${titleId}-kind`}>Event type</label>
            <select
              id={`${titleId}-kind`}
              className={filterClass}
              value={store.kind ?? ""}
              onChange={(event) =>
                store.setKind(activityKinds.find((kind) => kind === event.target.value))
              }
            >
              <option value="">All events</option>
              {activityKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabels[kind]}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={store.busy}
            onClick={() => void store.refresh()}
          >
            Refresh
          </Button>
        </div>
        {linkError && (
          <p role="alert" className="text-xs text-destructive">
            {linkError}
          </p>
        )}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-y border-border/65 pr-2 [scrollbar-gutter:stable]"
          aria-busy={store.busy}
        >
          {store.entries.length > 0 && (
            <ol className="divide-y divide-border/65" aria-label="Activity events">
              {store.entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} visit={visit} />
              ))}
            </ol>
          )}
          {store.error && (
            <p role="alert" className="py-4 text-sm text-destructive">
              {store.error}
            </p>
          )}
          {store.entries.length === 0 && !store.error && (
            <p role="status" className="py-6 text-sm text-muted-foreground">
              {store.busy ? "Loading activity…" : "No matching activity."}
            </p>
          )}
          {store.next && (
            <Button
              variant="ghost"
              size="sm"
              className="my-2"
              disabled={store.busy}
              onClick={() => void store.loadOlder()}
            >
              {store.busy ? "Loading…" : "Load older events"}
            </Button>
          )}
        </div>
      </DialogContent>
    </DialogBackdrop>
  );
});

type Visit = (open: () => void | boolean | Promise<void | boolean>) => Promise<void>;

const ActivityRow = observer(function ActivityRow({
  entry,
  visit,
}: {
  entry: ActivityEntry;
  visit: Visit;
}) {
  const root = useStore(RootStore);
  const projects = root.projectCatalogStore;
  const {
    projectPath,
    sessionId,
    automationId,
    automationRun,
    sourceSessionId,
    sourceMessageId,
    artifactLineageId,
  } = entry;
  const date = new Date(entry.at);
  const dateLabel = Number.isNaN(date.valueOf()) ? entry.at : dateFormat.format(date);
  const sessionTitle = sessionId ? root.sessionCatalogStore.find(sessionId)?.title : undefined;
  const linkClass = "text-xs text-accent underline-offset-2 hover:underline focus-visible:outline";
  return (
    <li className="grid min-w-0 gap-1 py-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-muted-foreground">
        <span>
          {entryLabels[entry.kind]}
          {entry.trigger && ` · ${entry.trigger}`}
        </span>
        <time className="tabular-nums" dateTime={entry.at}>
          {dateLabel}
        </time>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
        <span className="font-medium">{entry.title}</span>
        {entry.outcome && <span className="text-xs text-muted-foreground">{entry.outcome}</span>}
        {entry.tone === "error" && <span className="text-xs text-destructive">Error</span>}
        {entry.tone === "warning" && <span className="text-xs text-warning">Warning</span>}
      </div>
      {entry.detail && (
        <p className="whitespace-pre-wrap text-xs text-muted-foreground">{entry.detail}</p>
      )}
      {(projectPath ||
        sessionId ||
        automationId ||
        automationRun ||
        sourceSessionId ||
        artifactLineageId) && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {projectPath &&
            (projects.find(projectPath) ? (
              <button
                type="button"
                className={linkClass}
                onClick={() => void visit(() => root.navigationStore.openProjectChat(projectPath))}
              >
                {projects.nameForPath(projectPath)}
              </button>
            ) : (
              <span className="text-xs text-muted-foreground">
                {projects.nameForPath(projectPath)}
              </span>
            ))}
          {automationId && (
            <button
              type="button"
              className={linkClass}
              onClick={() => void visit(() => root.navigationStore.editAutomation(automationId))}
            >
              Open rule
            </button>
          )}
          {artifactLineageId && (
            <button
              type="button"
              className={linkClass}
              onClick={() =>
                void visit(() =>
                  root.navigationStore.showArtifactLibrary(undefined, artifactLineageId),
                )
              }
            >
              Open widget
            </button>
          )}
          {automationRun && (
            <button
              type="button"
              className={linkClass}
              onClick={() =>
                void visit(() => root.navigationStore.openAutomationRun(automationRun, entry.title))
              }
            >
              Open run
            </button>
          )}
          {sessionId && (
            <button
              type="button"
              className={linkClass}
              onClick={() => void visit(() => root.navigationStore.openSessionLink(sessionId))}
            >
              {sessionTitle || "Open session"}
            </button>
          )}
          {sourceSessionId && (
            <button
              type="button"
              className={linkClass}
              onClick={() =>
                void visit(() =>
                  root.navigationStore.openSessionLink(sourceSessionId, sourceMessageId),
                )
              }
            >
              {sourceMessageId
                ? "Trigger message"
                : entry.kind === "automation"
                  ? "Trigger session"
                  : "Source session"}
            </button>
          )}
        </div>
      )}
    </li>
  );
});
