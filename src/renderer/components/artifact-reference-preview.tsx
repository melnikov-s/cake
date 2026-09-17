import { useEffect } from "react";
import { observer } from "r-state-tree/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArtifactIcon } from "@/components/ui/icons";
import type {
  ArtifactLinkTarget,
  ArtifactStableRef,
} from "../../domain/artifacts/artifact-lineage";
import { parseArtifactRef } from "../../domain/artifacts/artifact-lineage";
import type { ArtifactLibraryStore } from "../stores/ArtifactLibraryStore";
import type { SessionCatalogStore } from "../stores/SessionCatalogStore";

export const ArtifactReferencePreview = observer(function ArtifactReferencePreview({
  reference,
  store,
  sessions,
  activeSessionId,
  onOpen,
}: {
  reference: ArtifactStableRef;
  store: ArtifactLibraryStore;
  sessions: SessionCatalogStore;
  activeSessionId?: string;
  onOpen(lineageId: string): void;
}) {
  useEffect(() => {
    void store.previewReference(reference);
  }, [reference, store]);
  const state = store.previewStates[reference];
  const parsed = parseArtifactRef(reference);
  const metadata = state?.metadata;
  const summary = activeSessionId ? sessions.find(activeSessionId) : undefined;
  const target: ArtifactLinkTarget | undefined = summary
    ? summary.familyId
      ? { type: "family", familyId: summary.familyId }
      : { type: "session", sessionId: summary.sessionId }
    : undefined;
  const linked = metadata?.links.some((link) => {
    if (!target || link.target.type !== target.type) return false;
    if (link.target.type === "family" && target.type === "family")
      return link.target.familyId === target.familyId;
    if (link.target.type === "session" && target.type === "session")
      return link.target.sessionId === target.sessionId;
    return false;
  });
  const linkAndResolve = async () => {
    if (!activeSessionId || !target || !metadata) return;
    const link = await store.link(
      activeSessionId,
      parsed.lineageId,
      target,
      parsed.revision ? { mode: "pinned", revision: parsed.revision } : { mode: "follow-latest" },
    );
    if (!link) return;
    await store.materialize(activeSessionId, parsed.lineageId, metadata.revision.revision);
  };
  return (
    <span
      data-artifact-reference={reference}
      className="my-1 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-2 align-middle text-xs shadow-xs"
    >
      <span className="text-muted-foreground">
        <ArtifactIcon />
      </span>
      <span className="min-w-0">
        <strong className="block max-w-[32rem] truncate text-foreground">
          {metadata?.lineage.title ?? parsed.lineageId}
        </strong>
        <span className="font-mono text-[10px] text-muted-foreground">
          {parsed.revision ? `Exact revision r${parsed.revision}` : "Stable reference"}
        </span>
      </span>
      {metadata && <Badge>{metadata.revision.kind}</Badge>}
      {state?.loading && <span className="text-[10px] text-muted-foreground">Resolving…</span>}
      {state?.error && <span className="text-[10px] text-destructive">Unavailable</span>}
      <Button size="sm" variant="outline" onClick={() => onOpen(parsed.lineageId)}>
        Open
      </Button>
      {activeSessionId && target && metadata && !linked && (
        <Button size="sm" onClick={() => void linkAndResolve()}>
          {target.type === "family" ? "Link to this family" : "Link to this session"}
        </Button>
      )}
      {linked && <Badge>{target?.type === "family" ? "Shared with family" : "Linked"}</Badge>}
    </span>
  );
});
