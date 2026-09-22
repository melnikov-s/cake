import { useState } from "react";
import { observer } from "r-state-tree/react";
import { ArtifactHost } from "@/components/artifact-host";
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
import { CopyIcon, RestoreIcon } from "@/components/ui/icons";
import { LoadingState } from "@/components/ui/loading-state";
import { Select } from "@/components/ui/select";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
  type ArtifactLinkTarget,
} from "../../domain/artifacts/artifact-lineage";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";
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
}: {
  store: ArtifactDetailStore;
  referencePreviews: ArtifactReferencePreviewStore;
  activeSessionId?: string;
  sessions: SessionCatalogStore;
  inlineWidgets: InlineWidgetStore;
}) {
  const [copied, setCopied] = useState<string>();
  const lineage = store.selectedLineage;
  if (!lineage)
    return (
      <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
        Choose an artifact to inspect its content, links, and revision history.
      </div>
    );
  if (store.detailLoading && !lineage.latest?.snapshot)
    return <LoadingState label="Loading artifact" />;

  const selectedNumber = store.selectedRevision ?? lineage.latestRevision;
  const selectedRevision = decodeArtifactRevisionNumber(selectedNumber);
  const latestRevision = decodeArtifactRevisionNumber(lineage.latestRevision);
  const selected = lineage.revision(selectedNumber);
  const record = selected?.record;
  const activeSummary = activeSessionId ? sessions.find(activeSessionId) : undefined;
  const target: ArtifactLinkTarget | undefined = activeSummary
    ? activeSummary.familyId
      ? { type: "family", familyId: activeSummary.familyId }
      : { type: "session", sessionId: activeSummary.sessionId }
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
  const exactRef = `${lineage.stableRef}@r${selectedNumber}`;
  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="border-b border-border/65 px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-display text-xl font-semibold">
                {lineage.title ?? lineage.id}
              </h1>
              <Badge>{selected?.kind ?? lineage.latest?.kind}</Badge>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted-foreground">
              Revision {selectedNumber} of {lineage.latestRevision}
              {selectedNumber < lineage.latestRevision ? " · Historical revision" : " · Latest"}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy("reference", lineage.stableRef)}
            >
              <CopyIcon /> {copied === "reference" ? "Copied" : "Copy reference"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => copy("exact", exactRef)}>
              <CopyIcon /> {copied === "exact" ? "Copied" : "Copy exact revision reference"}
            </Button>
            <Button variant="outline" size="sm" onClick={() => copy("id", lineage.id)}>
              <CopyIcon /> {copied === "id" ? "Copied" : "Copy ID"}
            </Button>
          </div>
        </div>
        {(store.operationError || referencePreviews.operationError) && (
          <Callout variant="error" className="mt-3">
            {store.operationError ?? referencePreviews.operationError}
          </Callout>
        )}
      </header>
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)_17rem] max-[900px]:grid-cols-1 max-[900px]:overflow-auto">
        <main className="min-h-0 overflow-auto p-6">
          {record ? (
            <ArtifactHost record={record} inlineWidgets={inlineWidgets} />
          ) : (
            <LoadingState label={`Loading revision ${selectedNumber}`} />
          )}
          {store.comparison && (
            <section
              className="mt-6 grid grid-cols-2 gap-3 max-[760px]:grid-cols-1"
              aria-label="Revision comparison"
            >
              <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/35 p-3 text-[11px] whitespace-pre-wrap">
                {store.comparison.fromText}
              </pre>
              <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/35 p-3 text-[11px] whitespace-pre-wrap">
                {store.comparison.toText}
              </pre>
            </section>
          )}
        </main>
        <aside className="min-h-0 overflow-auto border-l border-border/65 p-4 max-[900px]:border-l-0 max-[900px]:border-t">
          <h2 className="text-xs font-semibold">Revision history</h2>
          <Select
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
          <div className="mt-2 grid gap-2">
            {selectedNumber !== lineage.latestRevision && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void store.compare(lineageId, selectedRevision, latestRevision)}
                >
                  Compare with latest
                </Button>
                {activeSessionId && (
                  <Button size="sm" onClick={() => store.requestRestore(selectedRevision)}>
                    <RestoreIcon /> Restore as new latest
                  </Button>
                )}
              </>
            )}
          </div>
          <h2 className="mt-6 text-xs font-semibold">Linked sessions</h2>
          <div className="mt-2 grid gap-2 text-[11px]">
            {store.selectedLinks.length === 0 && (
              <p className="text-muted-foreground">Not linked to a session.</p>
            )}
            {store.selectedLinks.map((link) => (
              <div key={link.id} className="rounded-lg border border-border p-2">
                <strong>
                  {link.target.type === "family"
                    ? "Shared with family"
                    : (sessions.find(link.target.sessionId)?.title ?? link.target.sessionId)}
                </strong>
                <p className="mt-0.5 text-muted-foreground">
                  {link.mode === "follow-latest"
                    ? "Following latest"
                    : `Pinned r${link.pinnedRevision}`}
                </p>
              </div>
            ))}
          </div>
          {target && activeSessionId && (
            <div className="mt-4 grid gap-2 border-t border-border/65 pt-4">
              {!currentLink ? (
                <Button
                  size="sm"
                  onClick={() => void referencePreviews.link(activeSessionId, lineageId, target)}
                >
                  {target.type === "family" ? "Link to this family" : "Link to this session"}
                </Button>
              ) : (
                <>
                  {currentLink.mode === "pinned" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void referencePreviews.setSelection(activeSessionId, lineageId, target, {
                          mode: "follow-latest",
                        })
                      }
                    >
                      Follow latest
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        void referencePreviews.setSelection(activeSessionId, lineageId, target, {
                          mode: "pinned",
                          revision: selectedRevision,
                        })
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
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      {pendingRestoreRevision !== undefined && activeSessionId && (
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
