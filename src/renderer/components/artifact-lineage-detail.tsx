import { useState, type ReactNode } from "react";
import type { SourceLocation } from "../../contracts/editor/source-location";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import { observer } from "r-state-tree/react";
import { ArtifactHost } from "@/components/artifact-host";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import {
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ArtifactIcon, CopyIcon, RestoreIcon } from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { Select } from "@/components/ui/select";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  type ArtifactLinkTarget,
} from "../../contracts/artifacts/artifact-lineage";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";
import { SessionIdLink } from "./ui/session-id-link";
import type { ArtifactDetailStore } from "../stores/ArtifactDetailStore";
import type { ArtifactReferencePreviewStore } from "../stores/ArtifactReferencePreviewStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

const displayDate = (value: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );

export const ArtifactLineageDetail = observer(function ArtifactLineageDetail({
  store,
  referencePreviews,
  activeSessionId,
  sessions,
  inlineWidgets,
  compact = false,
  onOpenSourceLocation,
  wrapArtifact,
}: {
  store: ArtifactDetailStore;
  referencePreviews: ArtifactReferencePreviewStore;
  activeSessionId?: string;
  sessions: SessionCatalogStore;
  inlineWidgets: InlineWidgetStore;
  compact?: boolean;
  onOpenSourceLocation?(location: SourceLocation): void;
  wrapArtifact?(artifactId: string, children: ReactNode): ReactNode;
}) {
  const [copied, setCopied] = useState<string>();
  const lineage = store.selectedLineage;
  if (!lineage)
    return (
      <div className="grid h-full place-items-center content-center gap-3 p-8 text-center">
        <span className="grid size-10 place-items-center rounded-lg border border-border/70 bg-muted/40 text-muted-foreground">
          <ArtifactIcon />
        </span>
        <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
          Choose an artifact to inspect its content, links, and revision history.
        </p>
      </div>
    );
  if (store.detailLoading && !lineage.latest?.snapshot)
    return <LoadingState label="Loading artifact" />;

  const selectedNumber = store.selectedRevision ?? lineage.latestRevision;
  const selectedRevision = decodeArtifactRevisionNumber(selectedNumber);
  const latestRevision = decodeArtifactRevisionNumber(lineage.latestRevision);
  const selected = lineage.revision(selectedNumber);
  const kind = selected?.kind ?? lineage.latest?.kind;
  const isWorkboard = kind === "message-board";
  const record = selected?.record;
  const activeSummary = activeSessionId ? sessions.find(activeSessionId) : undefined;
  const target: ArtifactLinkTarget | undefined = activeSessionId
    ? activeSummary?.familyId
      ? { type: "family", familyId: activeSummary.familyId }
      : { type: "session", sessionId: activeSessionId }
    : undefined;
  const currentLink = target
    ? store.selectedLinks.find((link) => {
        if (link.lineageId !== lineage.id || link.target.type !== target.type) return false;
        if (link.target.type === "family" && target.type === "family")
          return link.target.familyId === target.familyId;
        if (link.target.type === "session" && target.type === "session")
          return link.target.sessionId === target.sessionId;
        return false;
      })
    : undefined;
  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 1_500);
    });
  };
  const lineageId = decodeArtifactLineageId(lineage.id);
  const pendingRestoreRevision = store.pendingRestoreRevision;
  const referenceOperationError = referencePreviews.operationErrorFor(lineageId);
  const exactRef = `${lineage.stableRef}@r${selectedNumber}`;
  const content = record ? (
    <ArtifactHost
      record={record}
      stateSessionId={currentLink ? activeSessionId : undefined}
      messageBoard={store.messageBoardStore}
      inlineWidgets={inlineWidgets}
      onOpenSourceLocation={onOpenSourceLocation}
    />
  ) : undefined;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)] phone:block phone:overflow-y-auto">
      <header
        className={cn(
          "border-b border-border/65 bg-background/60 px-5 py-3",
          compact && "px-4 py-2.5",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-base font-semibold tracking-tight text-foreground">
                {lineage.title ?? lineage.id}
              </h1>
              <Badge variant="secondary">{isWorkboard ? "Workboard" : kind}</Badge>
            </div>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
              {isWorkboard ? (
                "Append-only coordination log"
              ) : (
                <>
                  Revision {selectedNumber} of {lineage.latestRevision}
                  {selectedNumber < lineage.latestRevision ? " · Historical revision" : " · Latest"}
                </>
              )}
            </p>
          </div>
          <div className="inline-flex flex-wrap items-center gap-0.5 rounded-lg border border-border/80 bg-muted/40 p-0.5">
            <span className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground select-none">
              <CopyIcon /> Copy
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy reference"
              title="Copy reference"
              className="h-6 rounded-md px-2 text-xs font-medium text-foreground/85 hover:bg-card hover:text-foreground hover:shadow-2xs"
              onClick={() => copy("reference", lineage.stableRef)}
            >
              {copied === "reference" ? "Copied" : "Reference"}
            </Button>
            {!isWorkboard && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Copy exact revision reference"
                title="Copy exact revision reference"
                className="h-6 rounded-md px-2 font-mono text-xs font-medium text-foreground/85 hover:bg-card hover:text-foreground hover:shadow-2xs"
                onClick={() => copy("exact", exactRef)}
              >
                {copied === "exact" ? "Copied" : `r${selectedNumber} ref`}
              </Button>
            )}
            {!isWorkboard && activeSessionId && (
              <Button
                variant="ghost"
                size="sm"
                aria-label="Copy readable path"
                title="Copy readable path"
                className="h-6 rounded-md px-2 text-xs font-medium text-foreground/85 hover:bg-card hover:text-foreground hover:shadow-2xs"
                onClick={() =>
                  void referencePreviews
                    .materialize(activeSessionId, lineageId, selectedRevision)
                    .then((projection) => projection && copy("path", projection.exactPath))
                }
              >
                {copied === "path" ? "Copied" : "Path"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              aria-label="Copy ID"
              title="Copy ID"
              className="h-6 rounded-md px-2 text-xs font-medium text-foreground/85 hover:bg-card hover:text-foreground hover:shadow-2xs"
              onClick={() => copy("id", lineage.id)}
            >
              {copied === "id" ? "Copied" : "ID"}
            </Button>
          </div>
        </div>
        {(store.operationError || referenceOperationError) && (
          <Callout variant="error" className="mt-2.5">
            {store.operationError ?? referenceOperationError}
          </Callout>
        )}
      </header>
      <div
        className={cn(
          "grid min-h-0",
          isWorkboard
            ? "grid-cols-1"
            : "grid-cols-[minmax(0,1fr)_17rem] max-[900px]:grid-cols-1 max-[900px]:overflow-auto",
          compact && !isWorkboard && "grid-cols-1 overflow-auto",
        )}
      >
        <main
          className={cn(
            "min-h-0 overflow-auto p-6",
            compact && "p-4",
            compact && !isWorkboard && "overflow-visible",
          )}
        >
          {content ? (
            wrapArtifact ? (
              wrapArtifact(lineage.id, content)
            ) : (
              content
            )
          ) : (
            <LoadingState
              label={isWorkboard ? "Loading Workboard" : `Loading revision ${selectedNumber}`}
            />
          )}
          {!isWorkboard && store.comparison && (
            <section
              className="mt-6 overflow-hidden rounded-lg border border-border/80 bg-card/45"
              aria-label="Revision comparison"
            >
              <div className="grid grid-cols-2 divide-x divide-border/65 border-b border-border/65 bg-muted/40 text-xs font-medium text-muted-foreground max-[760px]:grid-cols-1 max-[760px]:divide-x-0 max-[760px]:divide-y">
                <div className="px-3.5 py-2 font-mono">
                  Revision r{store.comparison.fromRevision}
                </div>
                <div className="px-3.5 py-2 font-mono">
                  Revision r{store.comparison.toRevision} (Latest)
                </div>
              </div>
              <div className="grid grid-cols-2 divide-x divide-border/65 max-[760px]:grid-cols-1 max-[760px]:divide-x-0 max-[760px]:divide-y">
                <pre className="max-h-80 overflow-auto p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {store.comparison.fromText}
                </pre>
                <pre className="max-h-80 overflow-auto p-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                  {store.comparison.toText}
                </pre>
              </div>
            </section>
          )}
        </main>
        {!isWorkboard && (
          <aside
            className={cn(
              "min-h-0 overflow-auto border-l border-border/65 bg-sidebar/35 p-4 max-[900px]:border-l-0 max-[900px]:border-t",
              compact && "overflow-visible border-l-0 border-t",
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-semibold text-foreground">Revision history</h2>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {lineage.revisions.length}
              </span>
            </div>
            <Select
              size="sm"
              className="mt-2"
              aria-label="Selected artifact revision"
              value={selectedNumber}
              onChange={(event) =>
                void store.selectRevision(
                  lineageId,
                  decodeArtifactRevisionNumber(Number(event.target.value)),
                )
              }
            >
              {lineage.revisions
                .toSorted((left, right) => right.revision - left.revision)
                .map((revision) => (
                  <option key={revision.revision} value={revision.revision}>
                    r{revision.revision} · {displayDate(revision.publishedAt)}
                  </option>
                ))}
            </Select>
            {store.historyError && (
              <Callout variant="error" className="mt-2">
                {store.historyError}
              </Callout>
            )}
            {(store.historyHasMore || store.historyError) && (
              <Button
                className="mt-2 w-full"
                variant="outline"
                size="sm"
                disabled={store.historyLoading}
                onClick={() => void store.loadOlderHistory()}
              >
                {store.historyLoading
                  ? "Loading revision history…"
                  : store.historyError
                    ? "Retry revision history"
                    : "Load older revisions"}
              </Button>
            )}
            {selectedNumber !== lineage.latestRevision && (
              <div className="mt-2 grid gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void store.compare(lineageId, selectedRevision, latestRevision)}
                >
                  Compare with latest
                </Button>
                {activeSummary && (
                  <Button size="sm" onClick={() => store.requestRestore(selectedRevision)}>
                    <RestoreIcon /> Restore as new latest
                  </Button>
                )}
              </div>
            )}
            <div className="mt-5 border-t border-border/65 pt-4">
              <h2 className="text-xs font-semibold text-foreground">Linked sessions</h2>
              <div className="mt-2 grid gap-1.5 text-xs">
                {store.selectedLinks.length === 0 && (
                  <p className="text-muted-foreground">Not linked to a session.</p>
                )}
                {store.selectedLinks.map((link) => (
                  <div
                    key={link.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/75 bg-card/75 px-2.5 py-2"
                  >
                    <strong className="min-w-0 truncate font-medium text-foreground">
                      {link.target.type === "family"
                        ? "Shared with workgroup"
                        : link.target.sessionId === CAKE_CHAT_SESSION_ID
                          ? "Cake Chat"
                          : (sessions.find(link.target.sessionId)?.title ?? (
                              <SessionIdLink
                                sessionId={link.target.sessionId}
                                knownSessionIds={sessions.authoritativeSessionIds}
                              />
                            ))}
                    </strong>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {link.mode === "follow-latest"
                        ? "Following latest"
                        : `Pinned r${link.pinnedRevision}`}
                    </span>
                  </div>
                ))}
              </div>
              {target && activeSessionId && (
                <div className="mt-3 grid gap-1.5">
                  {!currentLink ? (
                    <Button
                      size="sm"
                      onClick={() =>
                        void referencePreviews.link(activeSessionId, lineageId, target)
                      }
                    >
                      {target.type === "family" ? "Link to this family" : "Link to this session"}
                    </Button>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      {currentLink.mode === "pinned" ? (
                        <Button
                          className="flex-1"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void referencePreviews.setSelection(
                              activeSessionId,
                              lineageId,
                              target,
                              {
                                mode: "follow-latest",
                              },
                            )
                          }
                        >
                          Follow latest
                        </Button>
                      ) : (
                        <Button
                          className="flex-1"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void referencePreviews.setSelection(
                              activeSessionId,
                              lineageId,
                              target,
                              {
                                mode: "pinned",
                                revision: selectedRevision,
                              },
                            )
                          }
                        >
                          Pin r{selectedNumber}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void referencePreviews.unlink(activeSessionId, lineageId, target)
                        }
                      >
                        Unlink
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
      {!isWorkboard && pendingRestoreRevision !== undefined && activeSessionId && (
        <DialogBackdrop onClose={() => store.cancelRestore()}>
          <DialogContent role="alertdialog" aria-labelledby="restore-artifact-title">
            <DialogHeader>
              <DialogTitle id="restore-artifact-title">
                Restore revision {pendingRestoreRevision}?
              </DialogTitle>
              <DialogDescription>
                This publishes its exact content as revision {lineage.latestRevision + 1}. Existing
                history remains unchanged.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => store.cancelRestore()}>
                Cancel
              </Button>
              <Button
                onClick={() =>
                  void store.restore(
                    activeSessionId,
                    lineageId,
                    pendingRestoreRevision,
                    lineage.latestRevision,
                  )
                }
              >
                Restore as new latest
              </Button>
            </DialogFooter>
          </DialogContent>
        </DialogBackdrop>
      )}
    </div>
  );
});
