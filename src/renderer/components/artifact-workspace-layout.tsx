import { useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { ArtifactHost } from "@/components/artifact-host";
import { AccessoryPanelLayout } from "@/components/ui/accessory-panel-layout";
import { Button } from "@/components/ui/button";
import { ArtifactIcon, BackIcon, CopyIcon, ForwardIcon } from "@/components/ui/icons";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/select";
import {
  decodeArtifactLineageId,
  decodeArtifactRevisionNumber,
} from "../../domain/artifacts/artifact-lineage";
import { IconButton } from "@/components/ui/icon-button";
import { NavItem } from "@/components/ui/nav-item";
import { SidePanel } from "@/components/ui/side-panel";
import type { SourceLocation } from "../../ipc/source-location";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";

export const ArtifactWorkspaceLayout = observer(function ArtifactWorkspaceLayout({
  session,
  inlineWidgets,
  onOpenSourceLocation,
  onOpenLibrary,
  children,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
  onOpenSourceLocation?(location: SourceLocation): void;
  onOpenLibrary(lineageId: string): void;
  children: ReactNode;
}) {
  const workspace = session.sessionArtifactsStore;
  const [copied, setCopied] = useState<string>();
  const selected = workspace.selectedRecord;
  const association = workspace.selectedAssociation;
  const lineage = association?.lineage;
  const selectedRevision = workspace.viewedRevision ?? association?.selectedRevision;
  const lineageId = lineage ? decodeArtifactLineageId(lineage.id) : undefined;
  const revisionNumber = selectedRevision
    ? decodeArtifactRevisionNumber(selectedRevision)
    : undefined;
  const exactRef = workspace.selectedExactRef;
  const title = selected?.artifact.title ?? lineage?.title ?? lineage?.id ?? "Artifacts";
  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      window.setTimeout(() => setCopied(undefined), 1_500);
    });
  };
  return (
    <AccessoryPanelLayout
      dataSlot="artifact-workspace-layout"
      open={workspace.open && workspace.records.length > 0}
      width={workspace.width}
      resizeLabel="Resize artifact workspace"
      onWidthChange={(width) => workspace.setWidth(width)}
      panel={
        <SidePanel
          title={selected ? title : "Artifacts"}
          eyebrow="Artifacts"
          onClose={() => workspace.close()}
        >
          {selected ? (
            <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
              <div className="flex items-center gap-1 border-b border-border/65 px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 px-2"
                  onClick={() => workspace.showList()}
                >
                  <BackIcon /> All artifacts
                </Button>
                <span className="ml-auto flex items-center gap-1">
                  <IconButton
                    tooltip="Previous artifact"
                    disabled={!workspace.hasPrevious}
                    onClick={() => workspace.showPrevious()}
                  >
                    <BackIcon />
                  </IconButton>
                  <IconButton
                    tooltip="Next artifact"
                    disabled={!workspace.hasNext}
                    onClick={() => workspace.showNext()}
                  >
                    <ForwardIcon />
                  </IconButton>
                </span>
              </div>
              <div className="min-h-0 overflow-auto p-4">
                {association && lineage && lineageId && revisionNumber && exactRef && (
                  <section className="mb-4 rounded-xl border border-border bg-card/65 p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>
                        {association.link?.target.type === "family"
                          ? "Shared with family"
                          : "Direct link"}
                      </Badge>
                      <Badge>
                        {association.link?.mode === "pinned"
                          ? `Pinned r${association.selectedRevision}`
                          : "Following latest"}
                      </Badge>
                      {association.selectedRevision < association.latestRevision && (
                        <span className="text-[11px] text-muted-foreground">
                          Showing r{association.selectedRevision}; latest is r
                          {association.latestRevision}
                        </span>
                      )}
                    </div>
                    <Select
                      className="mt-3"
                      size="sm"
                      aria-label="View artifact revision"
                      value={revisionNumber}
                      onChange={(event) =>
                        void workspace.viewRevision(
                          lineageId,
                          decodeArtifactRevisionNumber(Number(event.target.value)),
                        )
                      }
                    >
                      {lineage.revisions
                        .toSorted((left, right) => right.revision - left.revision)
                        .map((revision) => (
                          <option key={revision.revision} value={revision.revision}>
                            Revision {revision.revision}
                            {revision.revision === association.latestRevision ? " · Latest" : ""}
                          </option>
                        ))}
                    </Select>
                    {workspace.historyError && (
                      <Callout variant="error" className="mt-2">
                        {workspace.historyError}
                      </Callout>
                    )}
                    {(workspace.historyHasMore || workspace.historyError) && (
                      <Button
                        className="mt-2 w-full"
                        size="sm"
                        variant="outline"
                        disabled={workspace.historyLoading}
                        onClick={() => void workspace.loadOlderHistory()}
                      >
                        {workspace.historyLoading
                          ? "Loading revision history…"
                          : workspace.historyError
                            ? "Retry revision history"
                            : "Load older revisions"}
                      </Button>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => copy("stable", association.stableRef)}
                      >
                        <CopyIcon /> {copied === "stable" ? "Copied" : "Copy reference"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => copy("exact", exactRef)}>
                        <CopyIcon />{" "}
                        {copied === "exact" ? "Copied" : "Copy exact revision reference"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={workspace.operationLoading}
                        onClick={() =>
                          void workspace
                            .readablePath(lineageId, revisionNumber)
                            .then((path) => path && copy("path", path))
                        }
                      >
                        <CopyIcon /> {copied === "path" ? "Copied" : "Copy readable path"}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => copy("id", lineage.id)}>
                        <CopyIcon /> {copied === "id" ? "Copied" : "Copy ID"}
                      </Button>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {association.link?.mode === "pinned" ? (
                        <Button size="sm" onClick={() => void workspace.follow(lineageId)}>
                          Follow latest
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          onClick={() => void workspace.pin(lineageId, revisionNumber)}
                        >
                          Pin r{revisionNumber}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void workspace.unlink(lineageId)}
                      >
                        Unlink
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onOpenLibrary(lineage.id)}>
                        Open in Library
                      </Button>
                    </div>
                    {workspace.error && (
                      <Callout variant="error" className="mt-2">
                        {workspace.error}
                      </Callout>
                    )}
                  </section>
                )}
                <ArtifactHost
                  record={selected}
                  inlineWidgets={inlineWidgets}
                  onOpenSourceLocation={onOpenSourceLocation}
                />
              </div>
            </div>
          ) : (
            <nav className="h-full overflow-auto p-2" aria-label="Session artifacts">
              {workspace.records.map((record) => (
                <NavItem
                  key={record.artifact.id}
                  icon={<ArtifactIcon />}
                  label={record.artifact.title ?? record.artifact.id}
                  description={record.artifact.kind}
                  onClick={() => workspace.openArtifact(record.artifact.id)}
                />
              ))}
            </nav>
          )}
        </SidePanel>
      }
    >
      {children}
    </AccessoryPanelLayout>
  );
});
